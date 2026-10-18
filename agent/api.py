"""The app's one public process. It serves:

  /                 the web app, built by Vite into web/dist
  /api/reviews      REST for the browser
  /api/suggestions  follow-up prompts for the chat
  /mcp              an MCP server for other agents
  /agent/*          AG-UI runs, streamed through to the agent process

REST and MCP are thin wrappers over src/reviews.py. Routes and tools get
what they need through `Depends` (deps.py); the composition root at the
bottom builds it.

This is the only process with the read-write `app_rw` credentials. The chat
agent (main.py) runs separately on loopback and only ever gets `agent_ro`.
Reads (REST, MCP and the MCP `ask_reviews` graph) go through a second,
`agent_ro` connection, so SQL written by the model never runs on the
read-write role and only writes use `app_rw`.
"""

import os
import secrets
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

import httpx
import uvicorn
from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastmcp import FastMCP
from fastmcp.dependencies import Depends as McpDepends
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, TokenVerifier
from langchain.messages import HumanMessage
from pydantic import ValidationError
from starlette.background import BackgroundTask

from deps import (
    AgentClient,
    ChatModel,
    ReadDB,
    Services,
    WriteDB,
    mcp_ask_graph,
    mcp_read_db,
    mcp_write_db,
)
from src import reviews
from src.agent import TOOLS as CHAT_TOOLS
from src.context import AgentContext
from src.db import ReadWriteDB, ReviewsDB
from src.models import openai_model
from src.reviews import ReviewInput
from src.search_agent import build_graph as build_search_graph
from src.search_syntax import parse_search
from src.suggestions import SuggestionRequest, suggest


class SharedTokenVerifier(TokenVerifier):
    """Accepts one bearer token, MCP_TOKEN from the environment."""

    def __init__(self, token: str):
        super().__init__()
        self._token = token.encode()

    async def verify_token(self, token: str) -> AccessToken | None:
        if secrets.compare_digest(token.encode(), self._token):
            return AccessToken(token=token, client_id="mcp", scopes=[])
        return None


def first_error(e: ValidationError | RequestValidationError) -> str:
    err = e.errors()[0]
    # Our own validators' messages ("Title is required") arrive as
    # "Value error, Title is required".
    if err["type"] == "value_error":
        return str(err["ctx"]["error"])
    field = ".".join(str(p) for p in err["loc"] if p != "body")
    return f"{field}: {err['msg']}" if field else err["msg"]


def create_mcp(token: str) -> FastMCP:
    mcp = FastMCP(
        "book-reviews",
        instructions="Search, read and edit the book reviews in this app. "
        "Use ask_reviews for questions that need an answer with quotes; "
        "use search_reviews to find reviews and their ids.",
        auth=SharedTokenVerifier(token),
    )

    @mcp.tool(description=reviews.SEARCH_DESCRIPTION)
    @reviews.with_search_args
    async def search_reviews(db: ReviewsDB = McpDepends(mcp_read_db), **filters):
        return await reviews.search_for_model(db, **filters)

    @mcp.tool
    async def get_review(id: int, db: ReviewsDB = McpDepends(mcp_read_db)) -> dict:
        """One review in full, by id."""
        return await reviews.get(db, id) or _not_found(id)

    @mcp.tool
    async def create_review(
        title: str,
        author: str,
        rating: int,
        review: str = "",
        genre: Optional[str] = None,
        reviewer: Optional[str] = None,
        db: ReadWriteDB = McpDepends(mcp_write_db),
    ) -> dict:
        """Save a new review. `rating` is 1-5 stars. Returns the saved review
        with its id."""
        fields = dict(title=title, author=author, rating=rating, review=review, genre=genre, reviewer=reviewer)
        return await reviews.create(db, _input(fields))

    @mcp.tool
    async def update_review(
        id: int,
        title: Optional[str] = None,
        author: Optional[str] = None,
        rating: Optional[int] = None,
        review: Optional[str] = None,
        genre: Optional[str] = None,
        reviewer: Optional[str] = None,
        db: ReadWriteDB = McpDepends(mcp_write_db),
    ) -> dict:
        """Change a saved review. Only the fields you pass change; pass an
        empty string to clear genre or reviewer. `review` replaces the whole
        text. Returns the updated review."""
        fields = dict(title=title, author=author, rating=rating, review=review, genre=genre, reviewer=reviewer)
        changes = {k: v for k, v in fields.items() if v is not None}
        current = await reviews.get(db, id) or _not_found(id)
        return await reviews.update(db, id, _input({**current, **changes})) or _not_found(id)

    @mcp.tool
    async def delete_review(id: int, db: ReadWriteDB = McpDepends(mcp_write_db)) -> str:
        """Delete a review permanently."""
        if not await reviews.delete(db, id):
            _not_found(id)
        return f"Deleted review {id}."

    @mcp.tool
    async def ask_reviews(
        question: str,
        db: ReviewsDB = McpDepends(mcp_read_db),
        graph: Any = McpDepends(mcp_ask_graph),
    ) -> dict:
        """Answer one question about the reviews from what reviewers wrote,
        e.g. "which books did reviewers find slow to start but worth it?".
        Returns `text` with [n] markers and `citations`, each a review and a
        quote checked against that review's text. Takes 10-30 seconds."""
        thread_id = str(uuid4())
        try:
            state = await graph.ainvoke(
                {"messages": [HumanMessage(question)]},
                {"configurable": {"thread_id": thread_id}},
                context=AgentContext(db=db),
            )
        finally:
            await graph.checkpointer.adelete_thread(thread_id)
        return state.get("answer") or {"text": "No answer.", "citations": []}

    return mcp


def _input(fields: dict) -> ReviewInput:
    try:
        return ReviewInput.model_validate(fields)
    except ValidationError as e:
        raise ToolError(first_error(e))


def _not_found(id: int):
    raise ToolError(f"No review with id {id}.")


def _not_found_response():
    return JSONResponse({"error": "Not found"}, status_code=404)


router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok"}


@router.get("/api/reviews")
async def list_reviews(db: ReadDB, q: str = ""):
    """`q` is the search box: free text plus field filters
    (src/search_syntax.py). No `q` lists everything, newest first."""
    return await reviews.search(db, **parse_search(q), limit=100)


@router.post("/api/reviews", status_code=201)
async def create_review(r: ReviewInput, db: WriteDB):
    return await reviews.create(db, r)


@router.get("/api/reviews/{id}")
async def get_review(id: int, db: ReadDB):
    return await reviews.get(db, id) or _not_found_response()


@router.put("/api/reviews/{id}")
async def update_review(id: int, r: ReviewInput, db: WriteDB):
    return await reviews.update(db, id, r) or _not_found_response()


@router.delete("/api/reviews/{id}", status_code=204)
async def delete_review(id: int, db: WriteDB):
    return Response(status_code=204) if await reviews.delete(db, id) else _not_found_response()


@router.post("/api/suggestions")
async def suggestions(req: SuggestionRequest, model: ChatModel):
    """Follow-up prompts for the chat, from the end of the conversation
    (src/suggestions.py)."""
    return {"suggestions": await suggest(model, CHAT_TOOLS, req)}


@router.post("/agent/{path:path}")
async def agent_run(path: str, request: Request, agent: AgentClient):
    """The browser's only way to the agents: /agent/ is the chat agent,
    /agent/search the Ask agent. The AG-UI event stream (SSE) is passed
    through as it arrives."""
    upstream = await agent.send(
        agent.build_request(
            "POST",
            f"/{path}",
            content=await request.body(),
            headers={k: v for k, v in request.headers.items() if k in ("content-type", "accept")},
        ),
        stream=True,
    )
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
        background=BackgroundTask(upstream.aclose),
    )


def create_app(services: Services, mcp_token: str | None, web_dist: Path | None) -> FastAPI:
    mcp_app = create_mcp(mcp_token).http_app(path="/mcp", stateless_http=True) if mcp_token else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await services.open()
        try:
            if mcp_app:
                async with mcp_app.lifespan(app):
                    yield {"services": services}
            else:
                yield {"services": services}
        finally:
            await services.close()

    app = FastAPI(lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, e: RequestValidationError):
        if e.errors()[0]["loc"][0] == "path":  # /api/reviews/abc
            return _not_found_response()
        return JSONResponse({"error": first_error(e)}, status_code=400)

    app.include_router(router)

    if web_dist:
        # The built web app. React Router handles these paths in the browser,
        # so each one gets index.html; keep this list in step with the routes
        # in web/src/main.tsx.
        index = web_dist / "index.html"
        app.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="assets")
        app.add_api_route("/", lambda: FileResponse(index), include_in_schema=False)
        app.add_api_route("/reviews/{id}", lambda: FileResponse(index), include_in_schema=False)
        app.add_api_route("/favicon.svg", lambda: FileResponse(web_dist / "favicon.svg"), include_in_schema=False)

    if mcp_app:
        app.mount("/", mcp_app)  # last, so the routes above match first
    else:
        print("[api] MCP_TOKEN is not set; the MCP server at /mcp is off.")
    return app


# ---- Composition root ---------------------------------------------------

_model = openai_model()
_dist = Path(os.getenv("WEB_DIST", Path(__file__).parent.parent / "web" / "dist"))

app = create_app(
    Services(
        rw=ReadWriteDB(os.environ["APP_DATABASE_URL"]),
        ro=ReviewsDB(os.environ["AGENT_DATABASE_URL"]),
        model=_model,
        ask_graph=build_search_graph(_model),
        # No read timeout: a run streams for as long as the agent works.
        agent=httpx.AsyncClient(
            base_url=os.getenv("AGENT_URL", "http://127.0.0.1:8123"), timeout=httpx.Timeout(10, read=None)
        ),
    ),
    os.getenv("MCP_TOKEN") or None,
    # In dev Vite serves the web app and proxies the rest here, so there may be no build.
    _dist if (_dist / "index.html").exists() else None,
)


if __name__ == "__main__":
    # The container sets API_HOST=0.0.0.0 and API_PORT=3000: this is the
    # published port. Locally it stays on loopback behind Vite.
    uvicorn.run(app, host=os.getenv("API_HOST", "127.0.0.1"), port=int(os.getenv("API_PORT", "8124")))

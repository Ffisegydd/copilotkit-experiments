"""The reviews API: REST for the browser at /api/reviews and an MCP server for
other agents at /mcp, both thin wrappers over src/reviews.py.

This is the only process with the read-write `app_rw` credentials. It runs
separately from the chat agent (main.py), which only ever gets `agent_ro`.
It also holds an `agent_ro` connection for the MCP `ask_reviews` tool, so SQL
written by the model never runs on the read-write role.

Next.js rewrites /api/reviews/* and /mcp here (web/next.config.ts), so the
browser and MCP clients both use the app's one published port.
"""

import os
import secrets
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Optional
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AccessToken, TokenVerifier
from pydantic import ValidationError

from src import reviews
from src.context import AgentContext
from src.db import ReadWriteDB, ReviewsDB
from src.reviews import ReviewInput
from src.search_syntax import parse_search


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


def create_mcp(rw: ReadWriteDB, ro: ReviewsDB, token: str) -> FastMCP:
    mcp = FastMCP(
        "book-reviews",
        instructions="Search, read and edit the book reviews in this app. "
        "Use ask_reviews for questions that need an answer with quotes; "
        "use search_reviews to find reviews and their ids.",
        auth=SharedTokenVerifier(token),
    )

    @mcp.tool(description=reviews.SEARCH_DESCRIPTION)
    async def search_reviews(
        query: Optional[str] = None,
        title: Optional[str] = None,
        author: Optional[str] = None,
        genre: Optional[str] = None,
        reviewer: Optional[str] = None,
        exclude_titles: Optional[list[str]] = None,
        exclude_authors: Optional[list[str]] = None,
        exclude_genres: Optional[list[str]] = None,
        exclude_reviewers: Optional[list[str]] = None,
        min_rating: Optional[int] = None,
        max_rating: Optional[int] = None,
        limit: int = 20,
    ) -> list[dict] | str:
        rows = await reviews.search(
            rw, query, title, author, genre, reviewer,
            exclude_titles, exclude_authors, exclude_genres, exclude_reviewers,
            min_rating, max_rating, limit,
        )
        if not rows and genre:
            return await reviews.no_genre_match(rw, genre)
        return rows

    @mcp.tool
    async def get_review(id: int) -> dict:
        """One review in full, by id."""
        return await reviews.get(rw, id) or _not_found(id)

    @mcp.tool
    async def create_review(
        title: str,
        author: str,
        rating: int,
        review: str = "",
        genre: Optional[str] = None,
        reviewer: Optional[str] = None,
    ) -> dict:
        """Save a new review. `rating` is 1-5 stars. Returns the saved review
        with its id."""
        return await reviews.create(rw, _input(locals()))

    @mcp.tool
    async def update_review(
        id: int,
        title: Optional[str] = None,
        author: Optional[str] = None,
        rating: Optional[int] = None,
        review: Optional[str] = None,
        genre: Optional[str] = None,
        reviewer: Optional[str] = None,
    ) -> dict:
        """Change a saved review. Only the fields you pass change; pass an
        empty string to clear genre or reviewer. `review` replaces the whole
        text. Returns the updated review."""
        args = locals()
        changes = {k: v for k, v in args.items() if k != "id" and v is not None}
        current = await reviews.get(rw, id) or _not_found(id)
        return await reviews.update(rw, id, _input({**current, **changes})) or _not_found(id)

    @mcp.tool
    async def delete_review(id: int) -> str:
        """Delete a review permanently."""
        if not await reviews.delete(rw, id):
            _not_found(id)
        return f"Deleted review {id}."

    @mcp.tool
    async def ask_reviews(question: str) -> dict:
        """Answer one question about the reviews from what reviewers wrote,
        e.g. "which books did reviewers find slow to start but worth it?".
        Returns `text` with [n] markers and `citations`, each a review and a
        quote checked against that review's text. Takes 10-30 seconds."""
        # Imported here so the REST API starts without an OpenAI key.
        from langchain.messages import HumanMessage

        from src.search_agent import graph

        thread_id = str(uuid4())
        try:
            state = await graph.ainvoke(
                {"messages": [HumanMessage(question)]},
                {"configurable": {"thread_id": thread_id}},
                context=AgentContext(db=ro),
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


def create_app(rw: ReadWriteDB, ro: ReviewsDB, mcp_token: str | None) -> FastAPI:
    mcp_app = create_mcp(rw, ro, mcp_token).http_app(path="/mcp", stateless_http=True) if mcp_token else None

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with AsyncExitStack() as stack:
            for db in (rw, ro):
                await db.open()
                stack.push_async_callback(db.close)
            if mcp_app:
                await stack.enter_async_context(mcp_app.lifespan(app))
            yield

    app = FastAPI(lifespan=lifespan)
    not_found = lambda: JSONResponse({"error": "Not found"}, status_code=404)  # noqa: E731

    @app.exception_handler(RequestValidationError)
    async def bad_request(_: Request, e: RequestValidationError):
        if e.errors()[0]["loc"][0] == "path":  # /api/reviews/abc
            return not_found()
        return JSONResponse({"error": first_error(e)}, status_code=400)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/reviews")
    async def list_reviews(q: str = ""):
        """`q` is the search box: free text plus field filters
        (src/search_syntax.py). No `q` lists everything, newest first."""
        return await reviews.search(rw, **parse_search(q), limit=100)

    @app.post("/api/reviews", status_code=201)
    async def create_review(r: ReviewInput):
        return await reviews.create(rw, r)

    @app.get("/api/reviews/{id}")
    async def get_review(id: int):
        return await reviews.get(rw, id) or not_found()

    @app.put("/api/reviews/{id}")
    async def update_review(id: int, r: ReviewInput):
        return await reviews.update(rw, id, r) or not_found()

    @app.delete("/api/reviews/{id}", status_code=204)
    async def delete_review(id: int):
        return Response(status_code=204) if await reviews.delete(rw, id) else not_found()

    if mcp_app:
        app.mount("/", mcp_app)  # last, so the routes above match first
    else:
        print("[api] MCP_TOKEN is not set; the MCP server at /mcp is off.")
    return app


app = create_app(
    ReadWriteDB(os.environ["APP_DATABASE_URL"]),
    ReviewsDB(os.environ["AGENT_DATABASE_URL"], max_size=2),
    os.getenv("MCP_TOKEN") or None,
)


if __name__ == "__main__":
    # Loopback only: Next.js proxies to it.
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("API_PORT", "8124")))

"""Dependencies for the api process (api.py): what its REST routes and MCP
tools need, resolved per request with each framework's `Depends`.

The composition root at the bottom of api.py builds one `Services`. The
app's lifespan opens it and hands it to Starlette as lifespan state, which
every request (REST, and MCP requests through the mounted MCP app) sees as
`request.state.services`. Routes and tools declare what they need, e.g.
`db: WriteDB`, and tests swap any of it with `app.dependency_overrides`
(REST) or a different `Services` (both).
"""

from dataclasses import dataclass
from typing import Annotated, Any

import httpx
from fastapi import Depends, Request
from fastmcp.dependencies import CurrentRequest
from fastmcp.dependencies import Depends as McpDepends
from langchain_core.language_models import BaseChatModel

from src.db import ReadWriteDB, ReviewsDB


@dataclass(frozen=True)
class Services:
    rw: ReadWriteDB  # writes, as app_rw
    ro: ReviewsDB  # reads, as agent_ro, so model-written SQL never runs as app_rw
    model: BaseChatModel
    ask_graph: Any  # the Ask agent (src/search_agent.py), for MCP ask_reviews
    agent: httpx.AsyncClient  # the agent process, for the /agent/* proxy

    async def open(self) -> None:
        await self.rw.open()
        await self.ro.open()

    async def close(self) -> None:
        await self.agent.aclose()
        await self.ro.close()
        await self.rw.close()


def services(request: Request) -> Services:
    return request.state.services


# ---- REST (FastAPI) ---------------------------------------------------

def read_db(s: Annotated[Services, Depends(services)]) -> ReviewsDB:
    return s.ro


def write_db(s: Annotated[Services, Depends(services)]) -> ReadWriteDB:
    return s.rw


def chat_model(s: Annotated[Services, Depends(services)]) -> BaseChatModel:
    return s.model


def agent_client(s: Annotated[Services, Depends(services)]) -> httpx.AsyncClient:
    return s.agent


ReadDB = Annotated[ReviewsDB, Depends(read_db)]
WriteDB = Annotated[ReadWriteDB, Depends(write_db)]
ChatModel = Annotated[BaseChatModel, Depends(chat_model)]
AgentClient = Annotated[httpx.AsyncClient, Depends(agent_client)]


# ---- MCP (FastMCP) ----------------------------------------------------
# FastMCP has its own Depends. Its tools reach the same Services through the
# HTTP request the MCP call arrived on.


def mcp_services(request=CurrentRequest()) -> Services:
    return request.state.services


def mcp_read_db(s: Services = McpDepends(mcp_services)) -> ReviewsDB:
    return s.ro


def mcp_write_db(s: Services = McpDepends(mcp_services)) -> ReadWriteDB:
    return s.rw


def mcp_ask_graph(s: Services = McpDepends(mcp_services)) -> Any:
    return s.ask_graph

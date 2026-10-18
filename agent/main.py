"""Composition root: builds the agents' dependencies and serves the graphs
over AG-UI: the chat helper at `/` and the one-shot search agent (the list
page's "Ask" toggle) at `/search`."""

import os
from contextlib import asynccontextmanager

import uvicorn
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from copilotkit import LangGraphAGUIAgent
from fastapi import FastAPI

from src.agent import graph
from src.search_agent import graph as search_graph
from src.context import AgentContext
from src.db import ReviewsDB


class StatelessAGUIAgent(LangGraphAGUIAgent):
    """AG-UI agent that injects our runtime context and forgets each thread.

    Context: ag-ui-langgraph builds the graph's `context` from the run config
    (a dict of thread ids and CopilotKit data), which LangGraph would try to
    coerce into AgentContext and fail. We pass the real AgentContext instead.
    CopilotKit still reads its own data from the run config.

    Stateless: the browser sends the whole conversation and the form state with
    every request, so nothing needs to survive between runs. ag-ui-langgraph
    still needs a checkpointer during a run (it calls aget_state), so the graph
    keeps its MemorySaver, but we delete the thread's checkpoints afterwards.
    """

    agent_context: AgentContext | None = None

    def clone(self):
        # The FastAPI endpoint clones the agent per request, and clone() only
        # copies constructor arguments.
        copy = super().clone()
        copy.agent_context = self.agent_context
        return copy

    def get_stream_kwargs(self, *args, **kwargs):
        stream_kwargs = super().get_stream_kwargs(*args, **kwargs)
        stream_kwargs["context"] = self.agent_context
        return stream_kwargs

    async def run(self, input):
        input = input.model_copy(update={"messages": tool_results_after_calls(input.messages)})
        try:
            async for event in super().run(input):
                yield event
        finally:
            await self.graph.checkpointer.adelete_thread(input.thread_id)


def tool_results_after_calls(messages: list) -> list:
    """Move each tool result to directly after the assistant message that
    called it.

    The browser can send a backend tool's result after the assistant's reply
    to it ([call, reply, result]). CopilotKitMiddleware drops any tool call
    whose result isn't adjacent, and it edits the messages in place, so the
    call also vanishes from the snapshot we send back and its chip disappears
    from the chat. Results whose call isn't in the list stay where they are.
    """
    results = {m.tool_call_id: m for m in messages if m.role == "tool"}
    called = {tc.id for m in messages if m.role == "assistant" for tc in m.tool_calls or []}
    ordered = []
    for m in messages:
        if m.role == "tool" and m.tool_call_id in called:
            continue  # placed after its call below
        ordered.append(m)
        if m.role == "assistant":
            ordered.extend(results[tc.id] for tc in m.tool_calls or [] if tc.id in results)
    return ordered


def create_app(context: AgentContext) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await context.db.open()
        try:
            yield
        finally:
            await context.db.close()

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    agui_agent = StatelessAGUIAgent(
        name="book_helper",
        description="Answers questions about book reviews and helps fill in the review form.",
        graph=graph,
    )
    agui_agent.agent_context = context
    add_langgraph_fastapi_endpoint(app=app, agent=agui_agent, path="/")

    search_agent = StatelessAGUIAgent(
        name="review_search",
        description="Answers one question about the reviews, with citations.",
        graph=search_graph,
    )
    search_agent.agent_context = context
    add_langgraph_fastapi_endpoint(app=app, agent=search_agent, path="/search")
    return app


app = create_app(AgentContext(db=ReviewsDB(os.environ["AGENT_DATABASE_URL"])))


if __name__ == "__main__":
    # Bound to loopback: only the Next.js runtime in the same container talks to it.
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("AGENT_PORT", "8123")))

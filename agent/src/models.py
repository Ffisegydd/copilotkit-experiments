"""The chat model, built once per process and passed to whatever needs it.

Nothing else constructs a model. The composition roots (main.py for the agent
process, api.py for the api process) call `openai_model()` and hand the
result to the graph factories and the suggestions endpoint, so tests or a
different provider only need a different `BaseChatModel` there.
"""

import os

from langchain.agents.middleware import ModelRequest, wrap_model_call
from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI


def openai_model() -> BaseChatModel:
    """OpenAI's chat model, OPENAI_MODEL from the environment. Both processes
    need it, so a missing OPENAI_API_KEY stops them at startup rather than
    on the first chat."""
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set.")
    return ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-5.4"))


@wrap_model_call
async def one_tool_call_at_a_time(request: ModelRequest, handler):
    """Ask for at most one tool call per step.

    A setting on the agents' calls rather than on the shared model, because
    OpenAI rejects `parallel_tool_calls` on a request with no tools, like the
    suggestions call."""
    return await handler(request.override(model_settings={**request.model_settings, "parallel_tool_calls": False}))

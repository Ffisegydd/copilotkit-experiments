"""Follow-up suggestions for the chat, generated after each reply.

The browser's assistant-ui SuggestionAdapter (web/src/lib/suggestions.ts)
posts the end of the conversation and the chat's page context to
/api/suggestions, and shows what comes back as buttons under the reply.

The prompt lives here rather than in the browser, so the endpoint can only
ever produce follow-up prompts, not answer arbitrary text. What the helper
can do comes from its tools: the agent's own, passed in by api.py, and the
browser's frontend tools, which arrive with each request the same way they
reach the agent.
"""

from collections.abc import Sequence

from langchain_core.language_models import BaseChatModel
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

MAX_MESSAGES = 10
MAX_CHARS = 2000  # per message, and for the screen description

PROMPT = """
You suggest what the user might send next to the helper in a book review app.

Everything the helper can do is one of these tools. It can't do anything else
(it can't save or delete reviews: the user does that):
{tools}

Suggest exactly {count} short prompts in the user's voice (2-8 words each),
things these tools can do that follow on from the conversation and the
screen. Don't repeat what the user just asked. No numbering, no quotes.

Screen: {screen}

Conversation:
{transcript}
"""


class Message(BaseModel):
    role: str
    text: str


class ToolInfo(BaseModel):
    name: str = Field(max_length=64)
    description: str = Field(max_length=MAX_CHARS)


class SuggestionRequest(BaseModel):
    messages: list[Message] = Field(max_length=200)
    # The chat's frontend tools, as the browser sends them to the agent.
    tools: list[ToolInfo] = Field(default=[], max_length=20)
    # The chat's page context, which can include a review's full text or the
    # first 20 rows of the list; trimmed to MAX_CHARS for the prompt.
    screen: str = Field(default="", max_length=50_000)


class _Suggestions(BaseModel):
    prompts: list[str]


def _summary(description: str) -> str:
    """A tool description's first paragraph, which says what it does; the
    rest is argument detail the suggestions don't need."""
    return " ".join(description.strip().split("\n\n")[0].split())


async def suggest(
    model: BaseChatModel, agent_tools: Sequence[BaseTool], req: SuggestionRequest, count: int = 3
) -> list[str]:
    lines = [
        f"{m.role}: {m.text.strip()[:MAX_CHARS]}"
        for m in req.messages[-MAX_MESSAGES:]
        if m.role in ("user", "assistant") and m.text.strip()
    ]
    if not lines:
        return []
    tools = [(t.name, t.description) for t in agent_tools] + [(t.name, t.description) for t in req.tools]
    out = await model.with_structured_output(_Suggestions).ainvoke(
        PROMPT.format(
            count=count,
            tools="\n".join(f"- {name}: {_summary(description)}" for name, description in tools),
            screen=req.screen.strip()[:MAX_CHARS] or "unknown",
            transcript="\n".join(lines),
        )
    )
    return [p.strip() for p in out.prompts if p.strip()][:count]

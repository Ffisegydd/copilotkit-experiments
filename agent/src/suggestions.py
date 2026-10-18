"""Follow-up suggestions for the chat, generated after each reply.

The browser's assistant-ui SuggestionAdapter (web/src/lib/suggestions.ts)
posts the end of the conversation and the chat's page context to
/api/suggestions, and shows what comes back as buttons under the reply.

The prompt lives here rather than in the browser, so the endpoint can only
ever produce follow-up prompts, not answer arbitrary text.
"""

from langchain_core.language_models import BaseChatModel
from pydantic import BaseModel, Field

MAX_MESSAGES = 10
MAX_CHARS = 2000  # per message, and for the screen description

PROMPT = """
You suggest what the user might send next to the helper in a book review app.

The helper can: answer questions about saved reviews (search, counts, averages,
best and worst rated), open a review on its own page, filter the review list,
open a saved review in the form, and suggest text and ratings for the review
form, which the user accepts or rejects. It can't save, delete or browse the
web.

Suggest exactly {count} short prompts in the user's voice (2-8 words each),
things the helper can actually do that follow on from the conversation and
the screen. Don't repeat what the user just asked. No numbering, no quotes.

Screen: {screen}

Conversation:
{transcript}
"""


class Message(BaseModel):
    role: str
    text: str


class SuggestionRequest(BaseModel):
    messages: list[Message] = Field(max_length=200)
    # The chat's page context, which can include a review's full text or the
    # first 20 rows of the list; trimmed to MAX_CHARS for the prompt.
    screen: str = Field(default="", max_length=50_000)


class _Suggestions(BaseModel):
    prompts: list[str]


async def suggest(model: BaseChatModel, req: SuggestionRequest, count: int = 3) -> list[str]:
    lines = [
        f"{m.role}: {m.text.strip()[:MAX_CHARS]}"
        for m in req.messages[-MAX_MESSAGES:]
        if m.role in ("user", "assistant") and m.text.strip()
    ]
    if not lines:
        return []
    out = await model.with_structured_output(_Suggestions).ainvoke(
        PROMPT.format(count=count, screen=req.screen.strip()[:MAX_CHARS] or "unknown", transcript="\n".join(lines))
    )
    return [p.strip() for p in out.prompts if p.strip()][:count]

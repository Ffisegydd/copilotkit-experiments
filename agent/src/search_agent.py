"""One-shot search agent behind the "Ask" toggle on the review list.

The user asks a question; the agent searches the reviews as many times as it
needs (up to MAX_STEPS model calls) and finishes by calling `answer`. There's
no conversation: the browser sends one question per run and shows the answer
with its citations.

`answer` checks every citation before it reaches the UI. A citation must name
a review the agent actually retrieved during this run, its quote must appear
in that review's text, and the answer must point to it with an [n] marker.
An answer that fails goes back to the model to fix. On the last allowed step
the failing citations are dropped instead, along with their markers, so the
UI never shows a quote the review doesn't contain.
"""

import json
import re
from typing import Optional, TypedDict

from langchain.agents import AgentState as BaseAgentState
from langchain.agents import create_agent
from langchain.agents.middleware import ModelRequest, before_model, wrap_model_call
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import ToolRuntime, tool
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import BaseModel, Field

from src.agent import run_readonly_sql, search_reviews
from src.context import AgentContext
from src.models import one_tool_call_at_a_time

# Model calls per question, including the one that calls `answer`.
MAX_STEPS = 8


class Citation(TypedDict):
    n: int  # the [n] marker in the answer text
    id: int
    title: str
    author: str
    rating: int
    quote: Optional[str]  # exactly as it appears in the review


class Answer(TypedDict):
    text: str
    citations: list[Citation]


class SearchState(BaseAgentState):
    answer: Optional[Answer]


class CitationArg(BaseModel):
    id: int = Field(description="The review's id, from a search result.")
    quote: Optional[str] = Field(
        default=None,
        description="A short passage copied exactly from that review's text "
        "(5-25 words, one contiguous run, no ellipses). Omit only when the "
        "citation backs a fact like a rating or genre rather than an opinion.",
    )


@tool
async def answer(
    runtime: ToolRuntime[AgentContext],
    text: str,
    citations: Optional[list[CitationArg]] = None,
) -> Command | str:
    """Give the user your final answer, as your last step and on its own.
    If a citation doesn't check out you'll be told what to fix; call answer
    again with the whole corrected answer.

    `text` is plain prose (no markdown) with markers like [1] or [1][2] after
    the claims they support. Marker n refers to citations[n-1]. Paraphrase in
    `text`; don't put quotation marks in it. Quotes belong in citations, which
    are checked against the reviews and shown beside the answer."""
    citations = citations or []
    retrieved = _retrieved(runtime.state["messages"])
    ids = sorted({c.id for c in citations if c.id in retrieved})
    rows = await runtime.context.db.fetch(
        "SELECT id, title, author, rating, review FROM reviews WHERE id = ANY(%(ids)s)",
        {"ids": ids},
    )
    reviews = {r["id"]: r for r in rows}
    markers = [int(m) for m in re.findall(r"\[(\d+)\]", text)]

    # Check each citation, keyed by its original 1-based marker.
    valid: dict[int, Citation] = {}
    problems: list[str] = []
    for n, c in enumerate(citations, start=1):
        review = reviews.get(c.id)
        if not review:
            problems.append(f"Citation {n}: review #{c.id} isn't in your search results.")
            continue
        quote = None
        if c.quote:
            quote = find_quote(review["review"], c.quote)
            if quote is None:
                problems.append(f"Citation {n}: that quote isn't in review #{c.id}'s text. Copy it exactly.")
                continue
        if n not in markers:
            problems.append(f"Citation {n} has no [{n}] marker in the text.")
        valid[n] = {
            "n": 0,
            "id": c.id,
            "title": review["title"],
            "author": review["author"],
            "rating": review["rating"],
            "quote": quote,
        }
    problems += [f"Marker [{n}] has no citation." for n in sorted(set(markers)) if n > len(citations)]
    # Naming a book from the results is a claim about its review.
    cited = {c["title"].lower() for c in valid.values()}
    named = {
        t.lower(): (id, t)
        for id, t in retrieved.items()
        if t and len(t) > 3 and re.search(rf"\b{re.escape(t)}\b", text, re.IGNORECASE)
    }
    problems += [
        f'You mention "{t}" but don\'t cite review #{id}.' for key, (id, t) in named.items() if key not in cited
    ]

    # Send the answer back to be fixed while there are steps left. On the
    # last step, show what holds up instead of nothing.
    if problems and _steps(runtime.state["messages"]) < MAX_STEPS:
        return "Not shown to the user yet. Fix these, then call answer again:\n" + "\n".join(problems)

    # Renumber in order of first appearance in the text. Markers for failed
    # citations go, and so do citations the text never points to.
    order: list[int] = []
    for n in markers:
        if n in valid and n not in order:
            order.append(n)
    renumber = {old: new for new, old in enumerate(order, start=1)}
    text = re.sub(
        r"\[(\d+)\]",
        lambda m: f"[{renumber[int(m.group(1))]}]" if int(m.group(1)) in renumber else "",
        text,
    )
    text = re.sub(r"[ \t]+([.,;:!?])", r"\1", text).strip()
    final = [{**valid[old], "n": new} for old, new in renumber.items()]
    return Command(
        update={
            "answer": {"text": text, "citations": final},
            "messages": [
                ToolMessage(
                    content=f"Answer shown with {len(final)} citation(s).", tool_call_id=runtime.tool_call_id
                )
            ],
        }
    )


@before_model(can_jump_to=["end"])
def stop_after_answer(state: SearchState, runtime) -> dict | None:
    """End the run once `answer` has accepted an answer. (return_direct would
    end it after any answer call, including one sent back to be fixed.)"""
    return {"jump_to": "end"} if state.get("answer") else None


def _steps(messages: list) -> int:
    """Model calls since the question."""
    asked = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
    return sum(isinstance(m, AIMessage) for m in messages[(asked or [-1])[-1] + 1 :])


def _retrieved(messages: list) -> dict[int, str | None]:
    """Reviews that appeared in this run's search or SQL results: id -> title
    (None if the row had no title column)."""
    found: dict[int, str | None] = {}
    for m in messages:
        if not isinstance(m, ToolMessage) or m.name == "answer":
            continue
        try:
            rows = json.loads(m.content)
        except (TypeError, ValueError):
            continue
        if not isinstance(rows, list):
            continue
        for r in rows:
            if isinstance(r, dict) and isinstance(r.get("id"), int):
                found[r["id"]] = r.get("title") or found.get(r["id"])
    return found


_QUOTE_CHARS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-"})


def find_quote(review: str, quote: str) -> Optional[str]:
    """Return the passage of `review` matching `quote`, ignoring case,
    whitespace runs, curly quotes and dashes, or None if it isn't there.

    The result is the review's own text, so the UI can find it again."""

    def norm(s: str) -> tuple[str, list[int]]:
        out, index = [], []
        for i, ch in enumerate(s.translate(_QUOTE_CHARS).lower()):
            if ch.isspace():
                if out and out[-1] == " ":
                    continue
                ch = " "
            out.append(ch)
            index.append(i)
        return "".join(out), index

    hay, index = norm(review)
    needle = norm(quote.strip().strip("\"'“”"))[0].strip(" .")
    if len(needle) < 8:
        return None
    start = hay.find(needle)
    if start < 0:
        return None
    return review[index[start] : index[start + len(needle) - 1] + 1]


@wrap_model_call
async def require_tool_calls(request: ModelRequest, handler):
    """Every step must call a tool, so the run always ends in `answer`. On the
    last allowed step, `answer` is the only tool left."""
    if _steps(request.messages) >= MAX_STEPS - 1:
        return await handler(request.override(tools=[answer], tool_choice="answer"))
    return await handler(request.override(tool_choice="any"))


SYSTEM_PROMPT = """
You answer one question about a collection of book reviews. There is no
follow-up: the user can't reply, so never ask a question back. Make a sensible
reading of the question and answer it.

Search first. Try several phrasings and filters with search_reviews (it
stems words and tolerates typos) and use run_readonly_sql for counts,
averages and rankings. Two to four searches are usually enough. Answer from
what reviewers actually wrote in the results, not from what you know about
the books.

Finish by calling `answer`, on its own. Keep the answer to 1-4 sentences in
your own words. Put a marker like [1] after each claim taken from a review,
and give that citation a short quote copied exactly from the review's text.
Paraphrase in the answer itself and never quote there: only quotes in
citations are checked against the reviews, and the UI shows them next to
their markers. Cite every review you mention by name, and give every
citation a marker in the text. If the reviews don't answer the question,
say so plainly and cite nothing.
"""

def build_graph(model: BaseChatModel):
    return create_agent(
        model=model,
        tools=[search_reviews, run_readonly_sql, answer],
        middleware=[stop_after_answer, require_tool_calls, one_tool_call_at_a_time],
        state_schema=SearchState,
        context_schema=AgentContext,
        # Only needed during a run; main.StatelessAGUIAgent clears it afterwards.
        checkpointer=MemorySaver(),
        system_prompt=SYSTEM_PROMPT,
    )

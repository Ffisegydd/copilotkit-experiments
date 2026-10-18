"""Book review helper agent.

Tools fall into two groups:
- Database tools: read-only queries against the `reviews` table.
- `update_draft` and `edit_review`: work on the create/edit form the React
  app renders from shared state. `edit_review` loads a saved review into the
  `draft` key. `update_draft` never touches `draft`: everything it writes goes
  to the `proposal` key, and the form shows each value as a tracked change
  for the user to accept or reject, empty fields included. Neither writes to
  the database; the user saves the form themselves.

The web app also registers frontend tools (show_reviews, open_review) that
move the user between pages. CopilotKitMiddleware adds them to the model's
tools.

Dependencies (the database) aren't imported here. They arrive per run as the
graph's runtime context (`AgentContext`, see src/context.py), and tools read
them from `runtime.context`.
"""

import json
import os
import re
from typing import Optional, TypedDict

from copilotkit import CopilotKitMiddleware
from langchain.agents import AgentState as BaseAgentState
from langchain.agents import create_agent
from langchain.agents.middleware import ModelRequest, wrap_model_call
from langchain.messages import SystemMessage, ToolMessage
from langchain.tools import ToolRuntime, tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from src import reviews
from src.context import AgentContext


class Draft(TypedDict, total=False):
    id: Optional[int]  # set when editing an existing review
    title: str
    author: str
    genre: str
    rating: Optional[int]
    review: str
    reviewer: str


class AgentState(BaseAgentState):
    # None means no form is open in the UI.
    draft: Optional[Draft]
    # Everything update_draft has written, waiting for the user. Field -> suggested value; the form shows each as a tracked change.
    # Accepting copies the value into `draft`; rejecting drops it. The browser
    # does both with setState between runs.
    proposal: Optional[dict]


EMPTY_DRAFT: Draft = {
    "id": None,
    "title": "",
    "author": "",
    "genre": "",
    "rating": None,
    "review": "",
    "reviewer": "",
}


@tool(description=reviews.SEARCH_DESCRIPTION)
async def search_reviews(
    runtime: ToolRuntime[AgentContext],
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
    db = runtime.context.db
    rows = await reviews.search(
        db, query, title, author, genre, reviewer,
        exclude_titles, exclude_authors, exclude_genres, exclude_reviewers,
        min_rating, max_rating, limit,
    )
    if not rows and genre:
        return await reviews.no_genre_match(db, genre)
    return rows


_SELECT_ONLY = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)


@tool
async def run_readonly_sql(runtime: ToolRuntime[AgentContext], sql: str) -> list[dict] | str:
    """Run one read-only SQL SELECT against Postgres for aggregates or questions
    `search_reviews` can't answer (averages, counts per genre, etc.).

    Schema: reviews(id serial, title text, author text, genre text,
    rating smallint 1-5, review text, reviewer text, created_at timestamptz,
    updated_at timestamptz, search tsvector). The ranked search is also
    callable as search_reviews(q, has_title, has_author, has_genre,
    has_reviewer, not_title, not_author, not_genre, not_reviewer (text[]),
    rating_min, rating_max, max_results); use named arguments, e.g.
    SELECT genre, count(*) FROM search_reviews('space', rating_min => 4)
    GROUP BY genre.
    At most 100 rows are returned."""
    if not _SELECT_ONLY.match(sql) or ";" in sql.strip().rstrip(";"):
        return "Only a single SELECT (or WITH ... SELECT) statement is allowed."
    try:
        return await runtime.context.db.fetch(sql.strip().rstrip(";"))
    except Exception as e:  # surface SQL errors to the model so it can retry
        return f"Query failed: {e}"


@tool
def update_draft(
    runtime: ToolRuntime[AgentContext],
    title: Optional[str] = None,
    author: Optional[str] = None,
    genre: Optional[str] = None,
    rating: Optional[int] = None,
    review: Optional[str] = None,
    reviewer: Optional[str] = None,
) -> Command:
    """Fill in fields on the review form the user sees. Only pass the fields
    you want to change; others are left as they are. If no form is open, this
    opens a new, empty one. Every value, even for an empty field, is a
    suggestion the user accepts or rejects, and replaces any earlier
    suggestion for that field; pass the whole new value (e.g. the full review
    text). This does NOT save anything: the user clicks Save."""
    open_draft = runtime.state.get("draft")
    draft = dict(open_draft or EMPTY_DRAFT)
    proposal = dict(runtime.state.get("proposal") or {}) if open_draft else {}
    changes = {
        k: v
        for k, v in {
            "title": title,
            "author": author,
            "genre": genre,
            "rating": max(1, min(5, rating)) if rating is not None else None,
            "review": review,
            "reviewer": reviewer,
        }.items()
        if v is not None
    }
    suggested = []
    for k, v in changes.items():
        if draft.get(k) == v:
            proposal.pop(k, None)  # already in the form; nothing to suggest
        else:
            proposal[k] = v
            suggested.append(k)
    note = (
        f"Suggested {', '.join(suggested)}. Not in the form until the user accepts."
        if suggested
        else "No changes."
    )
    return Command(
        update={
            "draft": draft,
            "proposal": proposal or None,
            "messages": [
                ToolMessage(content=note, tool_call_id=runtime.tool_call_id)
            ],
        }
    )


@tool
async def edit_review(runtime: ToolRuntime[AgentContext], id: int) -> Command | str:
    """Open an existing saved review in the form so it can be changed, by id.
    Call this before update_draft when the user wants to change a saved
    review. Look the id up with search_reviews if you don't know it. The user
    still saves it themselves."""
    open_draft = runtime.state.get("draft")
    if open_draft and open_draft.get("id") != id:
        what = f"review #{open_draft['id']}" if open_draft.get("id") else "a new review"
        return f"The form is already open for {what}. Ask the user to save or cancel it first."
    rows = await runtime.context.db.fetch(
        "SELECT id, title, author, genre, rating, review, reviewer FROM reviews WHERE id = %(id)s",
        {"id": id},
    )
    if not rows:
        return f"There is no review #{id}."
    r = rows[0]
    draft: Draft = {**r, "genre": r["genre"] or "", "reviewer": r["reviewer"] or ""}
    return Command(
        update={
            "draft": draft,
            "proposal": None,
            "messages": [
                ToolMessage(
                    content=f'Opened review #{id} ("{r["title"]}") in the form.',
                    tool_call_id=runtime.tool_call_id,
                )
            ],
        }
    )


SYSTEM_PROMPT = """
You are the helper for a small book review app. Be brief: 1-3 sentences unless
the user asks for more.

What you can do:
- Answer questions about saved reviews using search_reviews or run_readonly_sql.
  Your database access is read-only. You cannot create, edit or delete reviews.
- Help the user write a review. The form they see is shown to you in the
  "Live form state" message at the end of the conversation. Trust it over
  anything said earlier: the user may have edited fields by hand. Put content
  into the form with update_draft rather than pasting it into chat. Calling
  update_draft with no form open opens a new one.
- Everything you put in the form with update_draft, including filling an
  empty field, shows up as a tracked change the user accepts or rejects.
  Until they do, the form keeps its old value, so say you've suggested the
  change, not made it. The live form state
  lists suggestions still waiting.
- When drafting review text, write in the user's voice from what they've told
  you. Ask a short question if you don't know their opinion of the book;
  don't invent one. Rating is an integer from 1 to 5.
- To change a saved review, open it in the form with edit_review first, then
  use update_draft.
- Use show_reviews and open_review to move the user around the app: open a
  review when they ask to see or read one, and filter the list when they ask
  to find or browse reviews. Look up the id with search_reviews first if you
  don't know it. Once a review is on screen, don't repeat its text in chat.

The user saves the form themselves with the Save button. Never claim a review
has been saved.
"""

model = ChatOpenAI(
    model=os.getenv("OPENAI_MODEL", "gpt-5.4"),
    model_kwargs={"parallel_tool_calls": False},
)


@wrap_model_call
async def live_form_state(request: ModelRequest, handler):
    """Show the model the form as it is right now, as the last message.

    The user edits the form between turns, so earlier chat messages (and the
    agent's own past update_draft calls) can be stale. A note at the end of
    the conversation is much harder for the model to overlook than one in the
    system prompt. It's added per call and never saved to the thread.
    """
    draft = request.state.get("draft")
    proposal = request.state.get("proposal")
    note = (
        "Live form state. This is the source of truth and includes any edits the "
        "user made by hand since your last message:\n"
        + (json.dumps(draft, ensure_ascii=False, indent=2) if draft else "No review form is open.")
    )
    if draft and proposal:
        note += (
            "\n\nYour suggestions still waiting for the user to accept or reject "
            "(not in the form yet):\n" + json.dumps(proposal, ensure_ascii=False, indent=2)
        )
    return await handler(request.override(messages=[*request.messages, SystemMessage(content=note)]))


class _CopilotKitMiddleware(CopilotKitMiddleware):
    """CopilotKit's middleware, told that our runtime context isn't prompt text.

    When a run has no CopilotKit app context, the stock middleware JSON-dumps
    `runtime.context` into the system prompt. Ours holds a database handle, so
    hide it; CopilotKit still finds the frontend's context through the run
    config as before.
    """

    def _build_app_context_note(self, state, runtime_context=None):
        if isinstance(runtime_context, AgentContext):
            runtime_context = None
        return super()._build_app_context_note(state, runtime_context)


graph = create_agent(
    model=model,
    tools=[search_reviews, run_readonly_sql, update_draft, edit_review],
    middleware=[_CopilotKitMiddleware(), live_form_state],
    state_schema=AgentState,
    context_schema=AgentContext,
    # Only needed during a run; main.StatelessAGUIAgent clears it afterwards.
    checkpointer=MemorySaver(),
    system_prompt=SYSTEM_PROMPT,
)

# Book review demonstrator

A CRUD app for book reviews with a CopilotKit chat sidebar backed by a LangChain/LangGraph agent. The agent can query the reviews database (read-only), fill in the review form through CopilotKit shared state, and move you around the app: open a review, or filter the list. The list's search box has an Ask mode that hands your question to a second, one-shot agent, which searches and answers with quotes it has checked against the review text.

## Run it

```bash
cp .env.example .env   # then set OPENAI_API_KEY
docker compose up --build
```

Open http://localhost:3000. Set `MCP_TOKEN` in `.env` to turn on the MCP server at http://localhost:3000/mcp (see MCP server below). Postgres is also published on `localhost:5433` for poking at with `psql`.

## Layout

```
db/migrations/         dbmate migrations, applied in order by the `migrate` service
  ..._reviews_and_roles.sql  reviews table, the two DB roles
  ..._search.sql             full-text + fuzzy search: tsvector, pg_trgm, search_reviews()
  ..._demo_reviews.sql       46 demo reviews
agent/                 all the Python: the agents and the reviews API, Python 3.12, uv
  main.py              agent process: builds AgentContext, serves both graphs over AG-UI
  api.py               api process: reviews REST at /api/reviews and the MCP server at /mcp (app_rw role)
  src/agent.py         chat agent: tools, state, system prompt, live-form middleware
  src/search_agent.py  Ask agent: one question, searches, a citation-checked answer
  src/context.py       AgentContext, the graph's runtime context (holds the DB)
  src/db.py            ReviewsDB (read-only Postgres client) and ReadWriteDB (api process only)
  src/reviews.py       every query on `reviews`; REST, MCP and the agent's tools all wrap it
  src/search_syntax.py parses search box filters (author:x, rating:>=4) into reviews.search() arguments
  tests/               pytest (`uv run pytest`)
web/                   Next.js 16 app: UI only, no database access
  src/components/AppShell.tsx  header, form, sidebar, navigation tools; form is bound to agent.state.draft
  src/app/page.tsx     review list + search, with the Search/Ask toggle
  src/components/AskPanel.tsx  runs the Ask agent and renders its progress, answer and sources
  src/app/reviews/[id] one review on its own page (?quote= marks a cited passage)
  src/components/ReviewForm.tsx  the form, with the agent's suggestions as tracked changes
  src/lib/sentenceDiff.ts  sentence-level diff behind those tracked changes
  src/app/api/copilotkit  CopilotKit runtime -> agents on 127.0.0.1:8123 (`/` chat, `/search` Ask)
  next.config.ts       rewrites /api/reviews/* and /mcp to the api process
Dockerfile, entrypoint.sh   one image running all three processes
```

## How the pieces talk

```
browser ── CopilotKit React (useAgent, CopilotSidebar)       MCP clients
   │  AG-UI over SSE, fetch /api/reviews                      │  /mcp, bearer token
   ▼                                                          ▼
Next.js :3000 ── /api/reviews, /mcp (rewrite) ──► api 127.0.0.1:8124 ──► Postgres (app_rw: CRUD)
   │  /api/copilotkit (CopilotRuntime)                         └─ ask_reviews ─► Postgres (agent_ro)
   │  LangGraphHttpAgent, loopback only
   ▼
agent 127.0.0.1:8123 (LangGraph) ──────────► Postgres (agent_ro: SELECT only)
```

The form doesn't keep its own React state. It renders `agent.state.draft` and writes edits back with `agent.setState`. The agent's `update_draft` tool returns a LangGraph `Command` that updates `proposal` (see Tracked changes below), which streams back to the browser as a state snapshot, so its suggestions appear in the form as soon as the tool finishes. Edits you make by hand go to the agent with the next message. A small middleware (`live_form_state`) appends the current form as the last message on every model call. Without it the model trusted earlier chat history ("4 stars") over the state note CopilotKit puts in the system prompt.

`draft: null` means no form is open. If you ask the agent to start a review from the list view, `update_draft` opens an empty form itself and fills it with suggestions. Only the user can save, using the Save button, because the agent has no write path.

## Tracked changes

The agent never writes to the form directly. Everything `update_draft` sends, including values for empty fields, goes into a second state key, `proposal` (field to suggested value), and `draft` is left alone until you accept. A later call for the same field replaces the suggestion. Asking for a new review opens an empty form with every field the agent filled waiting for you. Loading a saved review with `edit_review` isn't a change, so it goes straight into `draft`.

The form shows each suggestion where it applies. Short fields and the rating get a "Suggested" line under them with accept and reject buttons. The review text is replaced by a sentence-level diff of `draft.review` against `proposal.review` ([web/src/lib/sentenceDiff.ts](web/src/lib/sentenceDiff.ts), tested with `npm test`), and each changed run of sentences has its own buttons. Accepting a change applies it to the draft; rejecting reverts it in the suggestion. Either way the diff is worked out again, and once the two texts match the textarea comes back. Accept all and Reject all sit at the top.

All of this is `agent.setState({ draft, proposal })`, so the agent's next run sees exactly what you kept. `live_form_state` lists any suggestions still pending after the form, and the prompt tells the agent to say it has suggested a change, not made it. Ask "what did I keep?" after rejecting half of them and it knows. The buttons are disabled while the agent is running, because its run ends by sending back its own copy of the state, which would undo a decision made in the middle. Save keeps only what you accepted, and saving or cancelling drops anything still pending. `usePersistedChat` keeps `proposal` along with the draft.

## Navigating the UI

The list at `/` shows each review clipped to three lines; the title or Read opens it in full at `/reviews/<id>`. The chat sidebar, the form and the search query live in `AppShell`, which wraps every page, so the conversation and any open form survive moving between pages.

The agent moves you around with two CopilotKit frontend tools registered in `AppShell` with `useFrontendTool`: `open_review(id)` goes to a review's page, and `show_reviews(search?)` goes back to the list and optionally sets the search box. They run in the browser. `CopilotKitMiddleware` on the agent side adds them to the model's tools and hands calls back to the page, and the result ("Showing review #3 …") goes to the model on a follow-up run. Each page also tells the agent where you are through `useAgentContext`, so "change this one to 4 stars" works on a review's page.

`edit_review(id)` opens a saved review in the form. It's an agent-side tool, not a frontend one, because it changes `draft`. The follow-up run after a frontend tool starts from the agent's last state snapshot, so a `draft` written by `agent.setState` inside a frontend tool handler is lost before `update_draft` can see it.

## Search

The search box and the agent's `search_reviews` tool both call one Postgres function, `search_reviews`, defined in [db/migrations/20261017000002_search.sql](db/migrations/20261017000002_search.sql). It takes free text `q` plus structured filters (`has_genre`, `not_author`, `rating_min` and so on) and does two things with the text:

Ranked full-text search runs over a stored, weighted `tsvector` (title and author count most, then genre, then reviewer, then review body) with a GIN index. Queries use web-search syntax, so `"father and son"` matches a phrase, `-weir` excludes, `rocky or estraven` is an OR, and English stemming means "characters" finds "character".

Trigram matching (`pg_trgm`) on title + author catches typos: "piranisi", "le guinn", "mcarthy road". Scores from both are added together and results come back best first.

The search box also takes field filters. [agent/src/search_syntax.py](agent/src/search_syntax.py) parses them out of the query in `/api/reviews` and passes them to the function as arguments; the SQL doesn't parse anything. The agent's tool skips the syntax and takes the filters as typed arguments.

| Filter | Matches |
| --- | --- |
| `genre:horror`, `title:dune`, `author:"le guin"`, `reviewer:sam` | that field contains the value, any case. Quote values with spaces. `genre:fiction` matches all three fiction genres. |
| `rating:5`, `rating:>=4`, `rating:<3` | star rating, with `=`, `>`, `>=`, `<` or `<=` |
| `-genre:horror` | a leading `-` excludes (not for `rating`; write `rating:<5`) |

Filters are ANDed with each other and with whatever text is left, so `genre:horror hotel` finds The Shining. With only filters, results come newest first. An unknown field like `foo:bar`, a filter inside a quoted phrase, and an invalid rating stay as plain text. The parser's tests run with `uv run pytest` in `agent/`.

## Ask

Flip the toggle in front of the search box to Ask and type a question ("which books did reviewers find slow to start but worth it?"). It's one turn: no conversation, and asking again replaces the answer.

The question goes to a second LangGraph graph ([agent/src/search_agent.py](agent/src/search_agent.py)), served by the same Python process at `/search` and registered in the CopilotKit runtime as the `search` agent. `AskPanel` gets it with `useAgent({ agentId: "search" })` and calls `agent.runAgent()` directly rather than `copilotkit.runAgent`, so none of the chat's frontend tools or page context go with it. Each question gets a fresh thread id.

The graph has three tools: the chat agent's `search_reviews` and `run_readonly_sql`, and `answer(text, citations)`, where `text` carries `[n]` markers and each citation is a review id plus a quote. A `wrap_model_call` middleware sets `tool_choice` so every step must call a tool, and after seven steps leaves `answer` as the only one, so a run always ends in an answer.

`answer` checks the answer before the user sees it. Each cited review must have come back in one of this run's search or SQL results, each quote must appear in that review's text (ignoring case, whitespace runs and curly quotes), every citation needs a marker, every marker needs a citation, and every retrieved book the text names must be cited. If anything fails, the tool returns the list of problems to the model instead of an answer and the model tries again; the UI shows this as "Citations sent back". On the last step it keeps what checks out and strips the markers of what doesn't. Accepted answers go into the `answer` state key as `{text, citations}`, with each quote replaced by the review's own wording, and a `before_model` hook ends the run. The prompt also tells the model to paraphrase rather than quote in `text`, because only quotes in citations are checked.

While the run is going, the panel lists each search as it happens (from the tool calls in `agent.messages`) and streams the answer text from the `answer` call's arguments (`onToolCallArgsEvent` gives the partially parsed JSON). Markers are hidden until the checked answer arrives, because their numbers can change. Then each `[n]` becomes a link that shows its quote on hover or focus, the cited reviews are listed below, and "Read in context" opens `/reviews/<id>?quote=…`, which marks the passage and scrolls to it. The agent instance lives in the CopilotKit provider, so the answer is still there when you come back from a review (a full reload clears it).

## Migrations

The schema lives in `db/migrations/` as plain SQL files run by [dbmate](https://github.com/amacneil/dbmate). Each file has a `-- migrate:up` section and a `-- migrate:down` section. `docker compose up` starts a short-lived `migrate` container that applies any files not yet listed in the `schema_migrations` table, then exits, and the app only starts once that succeeds. Migrations run as `postgres`; the app and agent roles never get DDL rights.

To change the schema, add a new file rather than editing an applied one. Name it with a timestamp so it sorts last, e.g. `db/migrations/20261101093000_add_isbn.sql`, and fill in both sections. To change `search_reviews`, write a migration whose up section has the new `CREATE OR REPLACE FUNCTION` (or `DROP FUNCTION` first if the arguments change) and whose down section restores the previous version.

```bash
docker compose run --rm migrate up         # apply pending migrations
docker compose run --rm migrate rollback   # undo the latest one
docker compose run --rm migrate status     # list applied and pending
```

A database created before migrations existed (by the old `db/0*.sql` init scripts) already has the schema but no `schema_migrations` table, so `up` would fail on the first file. If it has the 12-argument `search_reviews`, mark all three as applied:

```bash
docker compose exec -T db psql -U postgres -d books -c "CREATE TABLE IF NOT EXISTS schema_migrations (version varchar(128) PRIMARY KEY); INSERT INTO schema_migrations VALUES ('20261017000001'), ('20261017000002'), ('20261017000003') ON CONFLICT DO NOTHING;"
```

Otherwise it's simplest to start again with `docker compose down -v`.

## MCP server

The api process also serves an MCP server over Streamable HTTP at `/mcp` (FastMCP, stateless, so any number of copies can run). Clients send `Authorization: Bearer $MCP_TOKEN`; with `MCP_TOKEN` unset the endpoint isn't mounted at all. To add it to Claude Code:

```bash
claude mcp add --transport http book-reviews http://localhost:3000/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

| Tool | Does |
| --- | --- |
| `search_reviews` | the agent's search tool: free text plus typed filters, same description |
| `get_review` | one review by id |
| `create_review`, `update_review`, `delete_review` | writes, as `app_rw`. `update_review` changes only the fields you pass |
| `ask_reviews` | runs the Ask graph in-process and returns `{text, citations}` with checked quotes |

All of them call [agent/src/reviews.py](agent/src/reviews.py), the same functions behind the REST routes and the chat agent's tools. `ask_reviews` hands the graph a `ReviewsDB` on `agent_ro`, so SQL the model writes through `run_readonly_sql` never runs as `app_rw`.

## What the agent can and can't touch

The agent connects to Postgres as `agent_ro`, which has `SELECT` on `reviews` and nothing else. Every session defaults to read-only with a 5s statement timeout, and each query also runs in an explicit `READ ONLY` transaction. `run_readonly_sql` rejects anything that isn't a single `SELECT`/`WITH`, but the role is the real guard: a `WITH x AS (DELETE ...)` that slips past the regex still fails in Postgres.

It has no file tools. On top of that, the container's root filesystem is mounted read-only (only `/tmp` is a writable tmpfs), and the agent runs as its own unprivileged `agent` user with `no_new_privs`.

`entrypoint.sh` starts each process with `env -i`, so the agent only sees `OPENAI_API_KEY`, `OPENAI_MODEL` and `AGENT_DATABASE_URL`. The api process holds the `app_rw` credentials and runs as a different user (`api`), so the agent can't read its environment through `/proc`. The web process has no database credentials at all.

The agent and the api listen on `127.0.0.1` inside the container. Only Next.js on :3000 is published. The only route through to the agent is the CopilotKit runtime at `/api/copilotkit`; the api is reachable only at the paths Next rewrites to it.

## Local development without Docker

```bash
docker compose up -d db migrate
cd agent && uv sync && set -a && source ../.env && set +a && \
  AGENT_DATABASE_URL=postgresql://agent_ro:agent_ro_pw@localhost:5433/books uv run python main.py
cd agent && set -a && source ../.env && set +a && \
  APP_DATABASE_URL=postgresql://app_rw:app_rw_pw@localhost:5433/books \
  AGENT_DATABASE_URL=postgresql://agent_ro:agent_ro_pw@localhost:5433/books uv run python api.py
cd web && npm install && npx next dev
```

With the Claude desktop app, `.claude/launch.json` defines the same three processes (`agent`, `api`, and `web` on port 3001 so it doesn't clash with the container).

## Known limits

- The agent is stateless: the browser sends the full conversation and form state with every request, and the agent deletes the thread's checkpoint when each run ends (`StatelessAGUIAgent` in `agent/main.py`). You can run as many copies as you like. The browser's copy is the only one, so `usePersistedChat` keeps the conversation and any open form in `sessionStorage`: they survive a reload (or the full page load Next does after a redeploy) but not closing the tab. See [docs/scaling.md](docs/scaling.md).
- The DB passwords in the first migration and `docker-compose.yml` are demo values.
- Versions are pinned to what CopilotKit's own `langgraph-fastapi` example uses (`copilotkit==0.1.96`, `ag-ui-langgraph==0.0.44`, `@copilotkit/*@1.79.1`). Their example notes that `ag-ui-langgraph` 0.0.43 breaks with this `copilotkit` version.

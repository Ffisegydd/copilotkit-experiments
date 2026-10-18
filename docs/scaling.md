# Scaling

The agent is stateless between requests. Every chat request from the browser carries the whole conversation (user messages, assistant replies, tool calls and their results) plus the current form state. The agent rebuilds context from that, answers, and forgets the thread. Any copy of the app can serve any request, so you scale out by running more copies behind a load balancer, with no sticky sessions and no shared session store.

Checked against `@assistant-ui/react-ag-ui@0.0.70`, `@ag-ui/client@0.0.59`, `copilotkit==0.1.96` and `ag-ui-langgraph==0.0.44`.

## How a request flows

1. The browser POSTs `RunAgentInput` to `/agent/`: thread id, the full message list, the shared `state` (including `draft`), the frontend tools and the page context. It reads the reply as an SSE stream of AG-UI events.
2. The api process (`agent/api.py`) streams the request through to the Python agent on `127.0.0.1:8123` and the events back. It keeps nothing.
3. `ag-ui-langgraph` loads the thread's checkpoint (empty, because we never keep one), merges in the messages and state from the request, and runs the graph.
4. When the run ends, `StatelessAGUIAgent.run` in `agent/main.py` deletes the thread's checkpoint.

The graph still has a `MemorySaver` because `ag-ui-langgraph` calls `aget_state` during a run and fails without a checkpointer. It holds one thread per in-flight run and nothing after that.

How I verified it: `docker compose restart app` mid-conversation, then a follow-up from the same tab, which recalled earlier details correctly. A scripted two-turn run against the agent endpoint showed zero stored threads after each turn, and the second turn still saw a rating edited by hand between turns.

## What statelessness costs

The only copy of a conversation lives in the browser. The web app keeps it in `sessionStorage`, so it survives a reload but not closing the tab; `localStorage` would keep it across tabs and restarts. Neither needs server storage. A reload in the middle of a run loses that run's reply, because nothing on the server can be reattached to.

The client controls the history, so a modified browser could send invented assistant messages or fake tool results. That's acceptable here because nothing the agent can do depends on trusting history: the `agent_ro` role enforces database access in Postgres, and only the user can save. Don't base authorisation decisions on chat history.

Requests grow with the conversation. Token cost is the same as with server-side memory, since the model sees the full history either way, but long chats will eventually need trimming or summarising before they hit the context window.

LangGraph interrupts won't work. Human-in-the-loop pauses (`interrupt()`) resume from a saved checkpoint, and checkpoints no longer survive the run. This app doesn't use them.

## Where the limits actually are

For short chat turns like these, you'll hit OpenAI rate limits long before CPU, memory or Postgres become a problem. Handle 429s with retry and backoff (`ChatOpenAI(max_retries=...)`), and cap concurrent runs per copy with an `asyncio.Semaphore` around the graph, so a burst queues in-process instead of failing.

Next come the SSE connections. Each in-flight turn holds an HTTP response open for as long as it runs, so set load balancer idle timeouts above your slowest turn.

Postgres connections come last. Each copy opens up to 4 `app_rw` connections (writes) and 8 `agent_ro` ones (4 for the agent process, 4 for reads in the api process), which is fine for tens of copies. Beyond that, put PgBouncer in front.

## Queueing, if you ever need it

The api's `/agent/*` proxy is the natural place for one. Instead of streaming a run straight through, it could put the run on a Postgres job table, have workers claim jobs with `FOR UPDATE SKIP LOCKED`, and stream their events back through `LISTEN`/`NOTIFY`. The browser would still see a stream; a queued run would just take longer to send `RUN_STARTED`.

Statelessness makes this simpler. The job row already contains everything a worker needs (the full `RunAgentInput`), so workers don't share any thread state. The only stored data is the run's event log, kept while the run is in flight.

LangGraph's own server (`langgraph-api`) has a Postgres-backed queue built in, with a per-thread `multitask_strategy` of `reject | rollback | interrupt | enqueue`. But it's built around server-side threads and needs Redis, which cuts against both the stateless design and the one-container constraint.

I wouldn't build either until the in-process semaphore stops being enough. That happens when you need backpressure across copies, fair ordering under load, or runs that outlive the HTTP request.

Sources: [LangGraph standalone server](https://docs.langchain.com/langsmith/deploy-standalone-server) and [MultitaskStrategy](https://reference.langchain.com/python/langgraph-sdk/auth/types/MultitaskStrategy).

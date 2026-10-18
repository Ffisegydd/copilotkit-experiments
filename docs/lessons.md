# Lessons

What this repo taught us about AG-UI, CopilotKit, assistant-ui and LangGraph agents with a UI attached. The README says how the app works; this says what we'd tell someone starting the same thing.

Versions throughout: `copilotkit==0.1.96`, `ag-ui-langgraph==0.0.44`, `@assistant-ui/react-ag-ui@0.0.70`, `@ag-ui/client@0.0.59`. Before the move, `@copilotkit/react-core` and `@copilotkit/runtime` 1.79.1.

## AG-UI is the part worth depending on

The app started as Next.js plus CopilotKit's React hooks and Node runtime in front of a Python LangGraph agent. The runtime turned out to be a relay: `LangGraphHttpAgent` forwarded `RunAgentInput` to `ag-ui-langgraph` and passed the SSE events back. The Python side was already speaking AG-UI, so the browser could speak it directly.

Swapping the frontend for Vite, `@ag-ui/client` and assistant-ui (commits `b6321a4`, `ca961d1`) removed the Node runtime, Next.js and three-process container. The image now runs two Python processes, and the diff removed about 25k lines and added 7k (most of both is lockfile churn). Nothing in the Python agent changed. That's the real argument for AG-UI: once both ends speak the protocol, the libraries on either side are replaceable.

What CopilotKit did that we had to rebuild: it generated chat suggestions with the model after every reply. assistant-ui has a `SuggestionAdapter` for this, but `useAgUiRuntime` ignores it (only the local runtime runs one), so we call the adapter ourselves when a run settles and keep the prompt on the server behind `/api/suggestions`. Adapters an integration doesn't wire are a recurring theme with these pre-1.0 runtimes: read what the runtime passes through before assuming a documented capability works.

The Python `copilotkit` package stays. `CopilotKitMiddleware` is what reads the frontend tools and page context out of each AG-UI request and puts them in front of the model. Only the browser half of CopilotKit is gone.

## Keep the agent stateless and let the browser hold the conversation

Every run carries the whole message list and the shared state. The agent rebuilds context from the request, answers, and forgets the thread, so any copy can serve any request with no sticky sessions or session store ([scaling.md](scaling.md)).

`ag-ui-langgraph` won't run without a checkpointer (it calls `aget_state` mid-run), so the graphs keep a `MemorySaver` and `StatelessAGUIAgent.run` deletes the thread when the run ends. Expect to need this trick with any AG-UI adapter built for server-side threads.

The costs are real and worth stating up front:

- LangGraph `interrupt()` can't work, because it resumes from a checkpoint that no longer exists.
- The client controls history and can forge tool results. Don't authorise anything based on it; here the database role and the user-only Save button do that job.
- Persistence becomes a browser problem. We keep the thread in `sessionStorage` through assistant-ui's history adapter. A reload mid-run loses that run's reply.
- Requests grow with the conversation. Token cost is the same as server-side memory, but long chats will need trimming.

## Shared state works, with two traps

The review form has no React state of its own. It renders the agent's `draft` (`useAgUiState`) and writes edits back with `useAgUiSetState`, so the agent's next run sees exactly what's on screen. It's the cleanest part of the app.

The first trap is that a run ends by sending back the agent's copy of the state, which silently undoes anything the user changed during the run. We disable the accept/reject buttons while the agent is running. Any UI that writes shared state needs the same rule or a merge strategy.

The second is that the model doesn't believe state it's shown in the system prompt. `CopilotKitMiddleware` puts the state there, and the model still trusted "4 stars" from earlier in the chat after the user had changed it to 3 by hand. The `live_form_state` middleware appends the current form as the last message on every model call (never saved to the thread), and the problem went away. Recency beats authority.

## Let the agent propose, not write

`update_draft` never touches `draft`. Everything it sends lands in a second key, `proposal`, and the form shows each value as a tracked change with accept and reject. The user decides; the agent's next run sees what they kept, because accepting and rejecting go through `setState` too. The prompt tells the model to say it has suggested a change, not made it, and `live_form_state` lists pending suggestions so "what did I keep?" has an answer.

This pairs with the agent having no write path at all. It connects as `agent_ro`, and only the user can save. That's why trusting client-sent history is acceptable here.

## Pick frontend or backend tools by what they change

A frontend tool (`open_review`, `show_reviews`) ends the run. The browser executes it and the result goes to the model on a follow-up run. That's fine for moving the user around. It's wrong for anything that changes shared state, because the state change and the agent's reply land in separate runs. `edit_review` loads a saved review into the form, so it's a backend tool that returns a LangGraph `Command` updating `draft` and replies in the same run.

Frontend tool results should describe what the user can actually see. `show_reviews` runs the same search the list page will run and reports "no reviews match" when the list is empty. Before that, the model would cheerfully announce results that weren't on screen.

## The glue between the Python pieces is where the bugs were

Most of the debugging time went into the seams between `ag-ui-langgraph`, `copilotkit` and LangGraph, not the protocol. All of it is in [agent/main.py](../agent/main.py), [agent/src/agent.py](../agent/src/agent.py) and [agent/src/context.py](../agent/src/context.py):

- `ag-ui-langgraph` builds the graph's runtime `context` from the run config, which LangGraph then fails to coerce into our `AgentContext`. We override `get_stream_kwargs` to pass the real one. The FastAPI endpoint clones the agent per request and `clone()` only copies constructor arguments, so the override of `clone()` has to carry it across.
- `ag-ui-langgraph` introspects the context schema as JSON Schema on every run. A live DB handle has none, so the field is `Annotated[ReviewsDB, SkipJsonSchema()]`.
- With no CopilotKit app context in the request, `CopilotKitMiddleware` JSON-dumps `runtime.context` into the system prompt. Ours holds a database handle, so a subclass hides it.
- The browser can send a tool result after the assistant reply that followed it (`[call, reply, result]`). `CopilotKitMiddleware` drops any tool call whose result isn't adjacent and edits the messages in place, so the call also disappears from the snapshot sent back and its chip vanishes from the chat. `tool_results_after_calls` reorders the messages before the run.
- `ag-ui-langgraph` 0.0.43's `clone()` passes kwargs that `copilotkit` 0.1.96 rejects. Pin the pair CopilotKit's own `langgraph-fastapi` example uses.

## Pin everything, and watch for two AG-UI client lines

The JS side is all pre-1.0 and releases every few days. CopilotKit 1.79 needed `@ag-ui/client` 1.0.x forced through npm `overrides`; `@assistant-ui/react-ag-ui` depends on the 0.0.x line. They can't share a tree, so a gradual migration with both libraries in one app isn't practical. We spiked assistant-ui in a separate `ui-spike/` app first, checked frontend tools, page context and shared state against the real agent, then replaced the frontend in one commit.

## Not every agent UI is a chat

The Ask panel is a one-shot agent: one question, several searches, an answer with citations. It drives a plain `HttpAgent` with `runAgent()` and re-renders on its events, with no assistant-ui and none of the chat's tools or context. AG-UI is a fine protocol for this, and a chat component would have been in the way.

What made it work:

- The answer is a tool call (`answer(text, citations)`), so the UI can stream the text from `onToolCallArgsEvent`'s partially parsed arguments while the model writes it.
- The tool validates before anything reaches the UI. Each quote must appear in a review the agent retrieved this run, every marker needs a citation, and every book named must be cited. Failures go back to the model as the tool result. On the last step it keeps what checks out instead of showing nothing.
- `tool_choice="any"` on every step, narrowing to `answer` alone on the last one, guarantees the run ends in an answer.
- A `before_model` hook ends the run once an answer is accepted. `return_direct` would also end it after a rejected answer.
- `[n]` markers are hidden while streaming, because their numbers change when failed citations are dropped and renumbered.

## Stock chat components need cutting down

assistant-ui's CLI copies in a full-featured `Thread`: attachments, edit, reload, branch picking, voice, reasoning blocks, tool groups, an export menu. Commits `34e96fd` and `f0c90c6` removed about 5,500 lines of it. Some of it was dead weight. Some was harmful: reload and edit re-run tools that navigate and change the form. Budget time to strip whatever the agent can't support.

Two framework behaviours caught us out. CopilotKit's `CopilotSidebar` memoises its chat view on the `header` prop, so an inline header object remounted the whole chat on every streamed token. In assistant-ui, `runtime.thread.reset()` also resets the agent state, so "New chat" has to put the open form back. Both are in [AppShell.tsx](../web/src/components/AppShell.tsx) (the first in its pre-migration history).

## One public process, the agent on loopback

The api process serves the static build, REST, MCP and an `/agent/*` proxy that streams POSTs through with no read timeout. The agent listens on `127.0.0.1`, runs as its own user with only three environment variables, and connects as a `SELECT`-only role. Because the browser only ever sees the api, swapping the frontend didn't touch any of this. It also made the MCP server cheap: REST, MCP and the agent's tools all wrap [reviews.py](../agent/src/reviews.py), and MCP's `ask_reviews` runs the Ask graph in-process.

import {
  CopilotRuntime,
  createCopilotEndpoint,
  InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import { handle } from "hono/vercel";

// The LangGraph agent runs in the same container, on loopback only, and speaks
// AG-UI directly (ag-ui-langgraph), so we use the HTTP agent rather than
// LangGraphAgent (which targets LangGraph Server's API).
const agentUrl = process.env.AGENT_URL || "http://127.0.0.1:8123";
const bookHelper = new LangGraphHttpAgent({ url: `${agentUrl}/` });
// One-shot answers with citations, behind the list page's "Ask" toggle.
const reviewSearch = new LangGraphHttpAgent({ url: `${agentUrl}/search` });

const runtime = new CopilotRuntime({
  agents: { default: bookHelper, search: reviewSearch },
  // The browser sends the full conversation with every run, so this cache is
  // only a convenience (a reloaded tab can reattach to its thread). Keep it small.
  runner: new InMemoryAgentRunner({ maxThreads: 200, maxRunsPerThread: 50, maxBytes: 64 * 1024 ** 2 }),
});

const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });

export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);

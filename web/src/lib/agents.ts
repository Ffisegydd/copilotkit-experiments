import { HttpAgent, type AbstractAgent } from "@ag-ui/client";
import { useEffect, useId, useReducer } from "react";

// The two LangGraph graphs, spoken to over AG-UI. The Python agent process
// serves them at / and /search; the api process (and Vite, in dev) proxies
// /agent/* to it, so they're same-origin.
//
// Module-level, so they outlive page changes: the Ask panel's last answer is
// still there when you come back from a cited review.
export const chatAgent = new HttpAgent({ url: "/agent/" });
export const searchAgent = new HttpAgent({ url: "/agent/search" });

// ---- Page context ----------------------------------------------------
// What each mounted component tells the chat agent about the screen, sent as
// RunAgentInput.context on every run (useAgUiRuntime's getRunContext).
// CopilotKitMiddleware on the agent side puts it in the system prompt.

type Context = { description: string; value: string };
const contexts = new Map<string, Context>();

export function useAgentContext({ description, value }: { description: string; value: unknown }) {
  const id = useId();
  const json = typeof value === "string" ? value : JSON.stringify(value);
  useEffect(() => {
    contexts.set(id, { description, value: json });
    return () => void contexts.delete(id);
  }, [id, description, json]);
}

export const runContext = (): Context[] => [...contexts.values()];

/** Re-renders when a raw AG-UI agent's messages, state or run status change.
 * The chat goes through assistant-ui; this is for the Ask panel, which drives
 * its agent directly. */
export function useAgentUpdates(agent: AbstractAgent) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: bump,
      onStateChanged: bump,
      onRunInitialized: bump,
      onRunFinalized: bump,
      onRunFailed: bump,
    });
    return unsubscribe;
  }, [agent]);
}

import type { AbstractAgent } from "@ag-ui/client";
import { useEffect, useId, useReducer } from "react";
import { useServices } from "@/lib/services";

// ---- Page context ----------------------------------------------------
// What each mounted component tells the chat agent about the screen, sent as
// RunAgentInput.context on every run (useAgUiRuntime's getRunContext).
// CopilotKitMiddleware on the agent side puts it in the system prompt.

export type ContextEntry = { description: string; value: string };

export type PageContext = {
  set(id: string, entry: ContextEntry): void;
  delete(id: string): void;
  /** Every entry currently on screen. */
  entries(): ContextEntry[];
};

export function createPageContext(): PageContext {
  const entries = new Map<string, ContextEntry>();
  return {
    set: (id, entry) => void entries.set(id, entry),
    delete: (id) => void entries.delete(id),
    entries: () => [...entries.values()],
  };
}

/** Tells the chat agent something about the screen for as long as the
 * calling component is mounted. */
export function useAgentContext({ description, value }: { description: string; value: unknown }) {
  const { pageContext } = useServices();
  const id = useId();
  const json = typeof value === "string" ? value : JSON.stringify(value);
  useEffect(() => {
    pageContext.set(id, { description, value: json });
    return () => pageContext.delete(id);
  }, [pageContext, id, description, json]);
}

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

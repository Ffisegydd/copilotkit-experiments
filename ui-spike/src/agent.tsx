// SPIKE: the chat agent over AG-UI with assistant-ui, no CopilotKit.
//
// Checks: frontend tools run in the browser and the agent's follow-up run
// sees their results; page context reaches the agent through RunAgentInput.context;
// shared state (draft/proposal) streams in and browser-side writes reach the
// next run.

import { HttpAgent } from "@ag-ui/client";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAgUiRuntime } from "@assistant-ui/react-ag-ui";
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";

type PageContext = { description: string; value: string };

const PageContextRef = createContext<{ current: PageContext[] } | null>(null);

/** What the page tells the agent about itself; sent with every run. */
export function usePageContext(entries: PageContext[]) {
  const ref = useContext(PageContextRef)!;
  ref.current = entries;
}

export function AgentProvider({ children }: { children: ReactNode }) {
  // Vite proxies /agent to the Python agent; FastAPI will serve it same-origin.
  const agent = useMemo(() => new HttpAgent({ url: "/agent/", threadId: crypto.randomUUID() }), []);
  const pageContext = useRef<PageContext[]>([]);

  const runtime = useAgUiRuntime({
    agent,
    getRunContext: () => pageContext.current,
    logger: { debug: (...a: unknown[]) => console.debug("[agui]", ...a), error: (...a: unknown[]) => console.error("[agui]", ...a) },
  });

  return (
    <PageContextRef.Provider value={pageContext}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </PageContextRef.Provider>
  );
}

import type { AbstractAgent } from "@ag-ui/client";
import { createContext, useContext, type ReactNode } from "react";
import type { PageContext } from "@/lib/agents";
import type { Api } from "@/lib/api";

// What the app talks to, built once in main.tsx (the composition root) and
// handed down here, so components don't import instances.
//
// The two LangGraph graphs are reached over AG-UI: the chat agent at
// /agent/ and the Ask agent at /agent/search. Both are created once for the
// whole app, so they outlive page changes: the Ask panel's last answer is
// still there when you come back from a cited review.
export type Services = {
  chatAgent: AbstractAgent;
  searchAgent: AbstractAgent;
  pageContext: PageContext;
  api: Api;
};

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices must be used inside <ServicesProvider>");
  return services;
}

"use client";

import { useEffect } from "react";
import type { useAgent } from "@copilotkit/react-core/v2";

type Agent = ReturnType<typeof useAgent>["agent"];
type Saved = { messages: Agent["messages"]; draft: unknown; proposal?: unknown };

const KEY = "book-reviews:chat";

// Keeps the conversation and the open form (with any pending suggestions) in
// sessionStorage so a full page load doesn't wipe them. Client-side
// navigation never does, but Next falls back to a full load when the server
// was redeployed since the tab opened, and F5 is a full load too. sessionStorage is per tab and goes when the tab
// closes. The agent keeps nothing between runs (see agent/main.py), so the
// browser's copy is the only one.
export function usePersistedChat(agent: Agent) {
  useEffect(() => {
    // Restore once, before anything has been said in this page load.
    if (agent.messages.length === 0) {
      const saved = read();
      if (saved?.messages.length) agent.setMessages(saved.messages);
      if (saved?.draft) agent.setState({ ...agent.state, draft: saved.draft, proposal: saved.proposal ?? null });
    }

    // Messages change on every streamed token, so batch the writes.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          write({ messages: agent.messages, draft: agent.state?.draft ?? null, proposal: agent.state?.proposal ?? null }),
        250,
      );
    };
    const { unsubscribe } = agent.subscribe({ onMessagesChanged: save, onStateChanged: save });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [agent]);
}

// Storage can be unavailable (private mode, blocked site data) or full; the
// chat still works, it just won't survive a reload.
function read(): Saved | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function write(saved: Saved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}

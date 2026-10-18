"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { z } from "zod";
import {
  CopilotSidebar,
  useAgent,
  useAgentContext,
  useConfigureSuggestions,
  useFrontendTool,
} from "@copilotkit/react-core/v2";
import { ReviewForm } from "@/components/ReviewForm";
import { useToolChips } from "@/components/ToolChip";
import { usePersistedChat } from "@/components/usePersistedChat";
import { diffSentences } from "@/lib/sentenceDiff";
import { type AgentState, type Draft, type Proposal, type Review, draftFromReview, emptyDraft } from "@/lib/types";

// What pages need from the shell. The search query lives here rather than in
// the list page so it survives a trip to a review and back, and so the agent's
// show_reviews tool can set it from any page.
type Ui = {
  query: string;
  setQuery: (q: string) => void;
  askMode: boolean; // the list page's search box asks the search agent instead
  setAskMode: (on: boolean) => void;
  reviewsVersion: number; // bumps after a save or delete; pages refetch on change
  editReview: (r: Review) => void;
  removeReview: (r: Review) => Promise<void>;
};

const UiContext = createContext<Ui | null>(null);

export function useUi() {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("useUi must be used inside <AppShell>");
  return ui;
}

const reviewIdFrom = (pathname: string) => {
  const m = pathname.match(/^\/reviews\/(\d+)/);
  return m ? Number(m[1]) : null;
};

async function fetchReview(id: number): Promise<Review | null> {
  const res = await fetch(`/api/reviews/${id}`);
  return res.ok ? res.json() : null;
}

// Clears the conversation only. An open form is the user's work, so it stays.
// The agent keeps nothing between runs, so there's no server-side thread to
// reset. Its own component so it can read the agent without making the header
// below depend on AppShell's renders.
function ClearChatButton() {
  const { agent } = useAgent();
  return (
    <button
      type="button"
      className="chat-clear"
      onClick={() => agent.setMessages([])}
      disabled={agent.isRunning || agent.messages.length === 0}
      title={agent.isRunning ? "Wait for the reply to finish" : "Start a new conversation"}
    >
      Clear
    </button>
  );
}

// Same header, plus a Clear button where CopilotKit would put its thread-drawer
// launcher (we don't use threads). Must be a constant: CopilotSidebar builds its
// chat view as a component memoised on `header`, so a new object each render
// remounts the whole chat (scroll position included) on every streamed token.
const CHAT_HEADER = {
  children: ({ titleContent, closeButton }: { titleContent: React.ReactElement; closeButton: React.ReactElement }) => (
    <header className="chat-header">
      <ClearChatButton />
      {titleContent}
      {closeButton}
    </header>
  ),
};

// Drops suggestions the draft already matches: accepted, typed in by hand, or
// a review text with every change accepted or rejected.
function settled(draft: Draft, proposal: Proposal | null): Proposal | null {
  if (!proposal) return null;
  const left = Object.fromEntries(
    Object.entries(proposal).filter(([k, v]) =>
      k === "review"
        ? diffSentences(draft.review, String(v)).some((s) => s.kind === "change")
        : v !== draft[k as keyof Draft],
    ),
  );
  return Object.keys(left).length ? left : null;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { agent } = useAgent();
  const router = useRouter();
  const pathname = usePathname();
  useToolChips();
  usePersistedChat(agent);
  const { draft = null, proposal = null } = (agent.state ?? {}) as AgentState;
  const viewingId = reviewIdFrom(pathname);

  const [query, setQuery] = useState("");
  const [askMode, setAskMode] = useState(false);
  const [reviewsVersion, setReviewsVersion] = useState(0);
  const reviewsChanged = useCallback(() => setReviewsVersion((v) => v + 1), []);
  // Open the chat by default only where it fits beside the page; on a phone
  // it would cover the whole app. Decided after mount (no window during SSR).
  const [chatOpen, setChatOpen] = useState(false);
  useEffect(() => setChatOpen(window.matchMedia("(min-width: 900px)").matches), []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared state: the form is just a view over agent.state.draft (and the
  // agent's pending suggestions in agent.state.proposal). Writing them here
  // makes the change visible to the agent on its next run; the agent's
  // update_draft tool writes them back and the form re-renders.
  const setForm = (next: Draft | null, nextProposal: Proposal | null = proposal) => {
    setError(null);
    agent.setState({ ...agent.state, draft: next, proposal: next ? settled(next, nextProposal) : null });
  };
  const setDraft = (next: Draft | null) => setForm(next);

  const save = async () => {
    if (!draft) return;
    if (!draft.rating) return setError("Pick a rating");
    setSaving(true);
    const res = await fetch(draft.id ? `/api/reviews/${draft.id}` : "/api/reviews", {
      method: draft.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    setSaving(false);
    if (!res.ok) return setError((await res.json()).error ?? "Save failed");
    const saved: Review = await res.json();
    setDraft(null);
    reviewsChanged();
    if (!draft.id) router.push(`/reviews/${saved.id}`);
  };

  const editReview = (r: Review) => setForm(draftFromReview(r), null);

  const removeReview = async (r: Review) => {
    if (!confirm(`Delete your review of "${r.title}"?`)) return;
    await fetch(`/api/reviews/${r.id}`, { method: "DELETE" });
    if (draft?.id === r.id) setDraft(null);
    reviewsChanged();
    if (viewingId === r.id) router.push("/");
  };

  // ---- Navigation tools ------------------------------------------------
  // Frontend tools: the agent calls them like its own tools, but they run
  // here in the browser. CopilotKitMiddleware on the agent side adds them to
  // the model's tool list and hands the call back to us; the result goes to
  // the model on a follow-up run.
  //
  // These only move the user around. Anything that changes the form (like
  // edit_review) is an agent-side tool: the run that follows a frontend tool
  // starts from the agent's last state snapshot, so a draft written here by
  // agent.setState would be lost.
  //
  // CopilotKit compares deps by JSON-serialising them, so only plain values go
  // there. `router` is a stable instance.

  useFrontendTool(
    {
      name: "show_reviews",
      description:
        "Take the user to the list of reviews. `search` is what goes in the search box: free text in " +
        "web-search syntax plus field filters (title:x, author:\"le guin\", genre:horror, reviewer:sam, " +
        "rating:>=4; a leading - excludes, e.g. -genre:horror). Pass an empty string to clear " +
        "the filter; omit it to keep the current one. Returns how many reviews are shown.",
      parameters: z.object({ search: z.string().optional() }),
      handler: async ({ search }) => {
        const q = (search ?? query).trim();
        if (search !== undefined) setQuery(search);
        setAskMode(false);
        router.push("/");
        if (!q) return "Showing the full list of reviews.";
        // Same request the list page makes, so the model hears about an empty
        // result instead of announcing a list the user can't see.
        const res = await fetch(`/api/reviews?q=${encodeURIComponent(q)}`);
        const titles = ((await res.json()) as Review[]).map((r) => r.title);
        return titles.length
          ? `Showing ${titles.length} reviews matching "${q}": ${titles.slice(0, 10).join(", ")}${titles.length > 10 ? ", …" : ""}.`
          : `No reviews match "${q}"; the list on screen is empty. Try different words.`;
      },
    },
    [query],
  );

  useFrontendTool(
    {
      name: "open_review",
      description: "Show one review on its own page, by id. Use this when the user wants to see or read a review.",
      parameters: z.object({ id: z.number().int() }),
      handler: async ({ id }) => {
        const r = await fetchReview(id);
        if (!r) return `There is no review #${id}.`;
        router.push(`/reviews/${id}`);
        return `Showing review #${id}: "${r.title}" by ${r.author}.`;
      },
    },
  );

  useAgentContext({
    description: "Which screen the user is on",
    value: [
      viewingId
        ? `Viewing review #${viewingId} on its own page`
        : query.trim()
          ? `Browsing the review list, filtered by the search "${query.trim()}"`
          : "Browsing the full review list",
      draft ? (draft.id ? `editing review #${draft.id} in the form` : "a new-review form is open") : "no form open",
    ].join("; "),
  });

  useConfigureSuggestions(
    {
      instructions: draft
        ? "Suggest short ways the assistant could help finish this review form, based on what's still empty."
        : viewingId
          ? "Suggest short follow-ups about the review on screen: similar books, other reviews by the same person, or editing it."
          : "Suggest short requests: finding or opening a particular review, questions about the saved reviews, or starting a new one.",
      maxSuggestions: 3,
    },
    [!!draft, viewingId],
  );

  return (
    <UiContext.Provider value={{ query, setQuery, askMode, setAskMode, reviewsVersion, editReview, removeReview }}>
      <div className="shell">
        <main>
          <header className="top">
            <h1>
              <Link href="/">Book Reviews</Link>
            </h1>
            {!draft && <button onClick={() => setDraft(emptyDraft())}>New review</button>}
          </header>

          {draft && (
            <ReviewForm
              draft={draft}
              proposal={proposal}
              onChange={setDraft}
              onReview={setForm}
              onSave={save}
              onCancel={() => setDraft(null)}
              saving={saving}
              error={error}
              agentBusy={agent.isRunning}
            />
          )}

          {children}
        </main>

        <CopilotSidebar
          open={chatOpen}
          onOpenChange={setChatOpen}
          width={420}
          header={CHAT_HEADER}
          labels={{
            modalHeaderTitle: "Review helper",
            welcomeMessageText:
              "Ask me about the reviews, have me find and open one, or open a new review and I'll help you write it.",
            chatInputPlaceholder: "Ask about reviews…",
          }}
        />
      </div>
    </UiContext.Provider>
  );
}

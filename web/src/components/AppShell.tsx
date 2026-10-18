import { AssistantRuntimeProvider, AuiConfig, AuiProvider, Suggestions, Tools, defineToolkit, useAui, useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { useAgUiRuntime, useAgUiSetState, useAgUiState, type AgUiAssistantRuntime } from "@assistant-ui/react-ag-ui";
import { MessageSquareIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import { ReviewForm } from "@/components/ReviewForm";
import { useAgentContext } from "@/lib/agents";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { diffSentences } from "@/lib/sentenceDiff";
import { useServices } from "@/lib/services";
import { createFollowUpAdapter, useFollowUpSuggestions } from "@/lib/suggestions";
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

// ---- Persistence -------------------------------------------------------
// The conversation and the open form (with any pending suggestions) go to
// sessionStorage so a reload doesn't wipe them. It's per tab and goes when the
// tab closes. The agent keeps nothing between runs (see agent/main.py), so the
// browser's copy is the only one. Storage can be unavailable (private mode,
// blocked site data) or full; the chat still works, it just won't survive a reload.

const KEY = "book-reviews:chat";
type Saved = { messages?: ThreadMessage[]; form?: AgentState };

function read(): Saved {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}

function write(patch: Saved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch }));
  } catch {}
}

// assistant-ui loads the saved conversation through a history adapter: a
// chain of messages, each pointing at the one before.
const savedHistory = {
  async load() {
    const messages = (read().messages ?? []).map((m) => ({ ...m, createdAt: new Date(m.createdAt) }));
    return {
      headId: messages.at(-1)?.id ?? null,
      messages: messages.map((message, i) => ({ message, parentId: messages[i - 1]?.id ?? null })),
    };
  },
  async append() {}, // the whole thread is written on every change instead
};

// Whether the chat is open, remembered per browser. The first time, it opens
// only where it fits beside the page; on a phone it would cover the whole app.
const OPEN_KEY = "book-reviews:chat-open";

function useChatOpen() {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(OPEN_KEY);
      if (saved !== null) return saved === "1";
    } catch {}
    return matchMedia("(min-width: 900px)").matches;
  });
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {}
  }, [open]);
  return [open, setOpen] as const;
}

const RuntimeContext = createContext<AgUiAssistantRuntime | null>(null);

function ChatRuntime({ children }: { children: ReactNode }) {
  const { chatAgent, pageContext } = useServices();
  const runtime = useAgUiRuntime({
    agent: chatAgent,
    getRunContext: pageContext.entries,
    showThinking: false,
    adapters: { history: savedHistory },
  });

  // Messages change on every streamed token, so batch the writes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = runtime.thread.subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { messages, isLoading } = runtime.thread.getState();
        if (!isLoading) write({ messages: [...messages] });
      }, 250);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [runtime]);

  return (
    <RuntimeContext.Provider value={runtime}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeContext.Provider>
  );
}

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

// The navigation tools' descriptions and schemas. Their execute functions
// need the router, so they're added in Shell; the descriptions also go to
// the suggestions endpoint, so follow-ups can offer what these tools do.
const NAVIGATION_TOOLS = {
  show_reviews: {
    description:
      "Take the user to the list of reviews. `search` is what goes in the search box: free text in " +
      'web-search syntax plus field filters (title:x, author:"le guin", genre:horror, reviewer:sam, ' +
      "rating:>=4; a leading - excludes, e.g. -genre:horror). Pass an empty string to clear " +
      "the filter; omit it to keep the current one. Returns how many reviews are shown.",
    parameters: { type: "object" as const, properties: { search: { type: "string" as const } } },
  },
  open_review: {
    description: "Show one review on its own page, by id. Use this when the user wants to see or read a review.",
    parameters: { type: "object" as const, properties: { id: { type: "integer" as const } }, required: ["id"] },
  },
};

const NAVIGATION_TOOL_INFO = Object.entries(NAVIGATION_TOOLS).map(([name, t]) => ({ name, description: t.description }));

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ChatRuntime>
      <Shell>{children}</Shell>
    </ChatRuntime>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const runtime = useContext(RuntimeContext)!;
  const { api, pageContext } = useServices();
  const aui = useAui();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const viewingId = reviewIdFrom(pathname);
  const agentBusy = useAuiState((s) => s.thread.isRunning);
  const hasMessages = useAuiState((s) => s.thread.messages.length > 0);

  // Shared state: the form is a view over the agent's `draft` (and its pending
  // suggestions in `proposal`). Writing them here makes the change visible to
  // the agent on its next run; the agent's update_draft tool writes them back.
  const state = useAgUiState<AgentState>();
  const setState = useAgUiSetState<AgentState>();
  const { draft = null, proposal = null } = state ?? {};

  // Restore the form saved before a reload, once; then keep the copy current.
  useEffect(() => {
    const form = read().form;
    if (form?.draft) setState((s) => ({ ...s, ...form }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => write({ form: { draft, proposal } }), [draft, proposal]);

  const [query, setQuery] = useState("");
  const [askMode, setAskMode] = useState(false);
  const [reviewsVersion, setReviewsVersion] = useState(0);
  const reviewsChanged = useCallback(() => setReviewsVersion((v) => v + 1), []);
  const [chatOpen, setChatOpen] = useChatOpen();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setForm = (next: Draft | null, nextProposal: Proposal | null = proposal) => {
    setError(null);
    setState((s) => ({ ...s, draft: next, proposal: next ? settled(next, nextProposal) : null }));
  };
  const setDraft = (next: Draft | null) => setForm(next);

  const save = async () => {
    if (!draft) return;
    if (!draft.rating) return setError("Pick a rating");
    setSaving(true);
    let saved: Review;
    try {
      saved = await api.saveReview(draft);
    } catch (e) {
      return setError(e instanceof ApiError ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
    setDraft(null);
    reviewsChanged();
    if (!draft.id) navigate(`/reviews/${saved.id}`);
  };

  const editReview = (r: Review) => setForm(draftFromReview(r), null);

  const removeReview = async (r: Review) => {
    if (!confirm(`Delete your review of "${r.title}"?`)) return;
    await api.deleteReview(r.id);
    if (draft?.id === r.id) setDraft(null);
    reviewsChanged();
    if (viewingId === r.id) navigate("/");
  };

  // Clears the conversation only. An open form is the user's work, so it
  // stays (resetting the thread also resets the agent state, so put it back).
  const clearChat = () => {
    runtime.thread.reset();
    setState({ draft, proposal });
    write({ messages: [] });
  };

  // ---- Navigation tools ------------------------------------------------
  // Frontend tools: the agent calls them like its own tools, but they run
  // here in the browser. CopilotKitMiddleware on the agent side adds them to
  // the model's tool list (they arrive as RunAgentInput.tools) and the result
  // goes back to the model on a follow-up run.
  //
  // These only move the user around. Anything that changes the form (like
  // edit_review) is an agent-side tool, so the state change and the reply
  // happen in one run.
  const toolkit = defineToolkit({
    show_reviews: {
      ...NAVIGATION_TOOLS.show_reviews,
      execute: async ({ search }: { search?: string }) => {
        const q = (search ?? query).trim();
        if (search !== undefined) setQuery(search);
        setAskMode(false);
        navigate("/");
        if (!q) return "Showing the full list of reviews.";
        // Same request the list page makes, so the model hears about an empty
        // result instead of announcing a list the user can't see.
        const titles = (await api.listReviews(q)).map((r) => r.title);
        return titles.length
          ? `Showing ${titles.length} reviews matching "${q}": ${titles.slice(0, 10).join(", ")}${titles.length > 10 ? ", …" : ""}.`
          : `No reviews match "${q}"; the list on screen is empty. Try different words.`;
      },
    },
    open_review: {
      ...NAVIGATION_TOOLS.open_review,
      execute: async ({ id }: { id: number }) => {
        const r = await api.getReview(id);
        if (!r) return `There is no review #${id}.`;
        navigate(`/reviews/${id}`);
        return `Showing review #${id}: "${r.title}" by ${r.author}.`;
      },
    },
  });

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

  // Before the first message, a fixed set for the screen; after each reply,
  // follow-ups the model wrote for it.
  const followUpAdapter = useMemo(
    () => createFollowUpAdapter({ api, getContext: pageContext.entries, tools: NAVIGATION_TOOL_INFO }),
    [api, pageContext],
  );
  const followUps = useFollowUpSuggestions(runtime, followUpAdapter);
  const suggestions = useMemo(
    () =>
      hasMessages
        ? followUps.map((s) => s.prompt)
        : draft
          ? [
              { title: "Fill in the rest", label: "of the form", prompt: "Fill in whatever is still empty in the form." },
              { title: "Tighten the review", label: "shorter and clearer", prompt: "Tighten up the review text." },
            ]
          : viewingId
            ? [
                { title: "Similar books", label: "to this one", prompt: "Find reviews of books similar to this one." },
                { title: "Edit this review", label: "in the form", prompt: "Open this review in the editor." },
              ]
            : [
                { title: "Best-rated genre", label: "across all reviews", prompt: "Which genre gets the best ratings?" },
                { title: "Start a review", label: "with my help", prompt: "Help me write a new review." },
              ],
    [hasMessages, followUps, !!draft, viewingId],
  );

  const config = AuiConfig({ tools: Tools({ toolkit }), suggestions: Suggestions(suggestions) });

  return (
    <UiContext.Provider value={{ query, setQuery, askMode, setAskMode, reviewsVersion, editReview, removeReview }}>
      {/* On wide screens the open chat sits beside the page; narrower, it covers it. */}
      <div className={cn("transition-[padding] duration-200", chatOpen && "min-[900px]:pr-[420px]")}>
        <main className="mx-auto w-full max-w-3xl space-y-5 px-4 pt-8 pb-24">
          <header className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold">
              <Link to="/">Book Reviews</Link>
            </h1>
            <div className="flex gap-2">
              {!draft && <Button onClick={() => setDraft(emptyDraft())}>New review</Button>}
            </div>
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
              agentBusy={agentBusy}
            />
          )}

          {children}
        </main>

      </div>

      {/* Stays mounted while closed, so the conversation keeps its scroll
          position and a run in progress carries on. */}
      <aside
        aria-label="Review helper"
        aria-hidden={!chatOpen}
        inert={!chatOpen}
        className={cn(
          "bg-background fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l shadow-xl transition-transform duration-200 min-[900px]:w-[420px] min-[900px]:shadow-none",
          !chatOpen && "translate-x-full",
        )}
      >
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <MessageSquareIcon className="text-primary size-4" />
          <span className="flex-1 text-sm font-semibold">Review helper</span>
          <Button variant="ghost" size="sm" onClick={clearChat} disabled={agentBusy || !hasMessages} title="Start a new conversation">
            <RotateCcwIcon /> New chat
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setChatOpen(false)} aria-label="Close the assistant">
            <XIcon />
          </Button>
        </header>
        <div className="min-h-0 flex-1">
          <AuiProvider extends={aui} config={config}>
            <Thread />
          </AuiProvider>
        </div>
      </aside>

      {!chatOpen && (
        <Button size="lg" className="fixed right-5 bottom-5 z-20 rounded-full shadow-lg" onClick={() => setChatOpen(true)}>
          <MessageSquareIcon /> {agentBusy ? "Assistant is working…" : "Ask the assistant"}
        </Button>
      )}
    </UiContext.Provider>
  );
}

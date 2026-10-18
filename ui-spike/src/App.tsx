import { AuiConfig, AuiProvider, Suggestions, Tools, defineToolkit, useAui } from "@assistant-ui/react";
import { useAgUiSetState, useAgUiState } from "@assistant-ui/react-ag-ui";
import { useEffect, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { Button } from "@/components/ui/button";
import { AgentProvider, usePageContext } from "./agent";

type Review = { id: number; title: string; author: string; genre: string | null; rating: number; review: string };
type Draft = { id: number | null; title: string; author: string; genre: string; rating: number | null; review: string; reviewer: string };
type AgentState = { draft?: Draft | null; proposal?: Partial<Draft> | null };

const getJson = async <T,>(url: string): Promise<T | null> => {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
};

function ReviewList() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [q] = useSearchQuery();
  useEffect(() => {
    getJson<Review[]>(`/api/reviews?q=${encodeURIComponent(q)}`).then((r) => setReviews(r ?? []));
  }, [q]);
  usePageContext([
    {
      description: "Reviews currently shown in the list (first 20)",
      value: JSON.stringify(reviews.slice(0, 20).map(({ id, title, author, rating }) => ({ id, title, author, rating }))),
    },
  ]);
  return (
    <ul className="space-y-2">
      {q && <p className="text-muted-foreground text-sm">Search: {q}</p>}
      {reviews.map((r) => (
        <li key={r.id} className="rounded-lg border p-3">
          <Link to={`/reviews/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
          <span className="text-muted-foreground text-sm"> · {r.author} · {"★".repeat(r.rating)}</span>
        </li>
      ))}
    </ul>
  );
}

function ReviewPage() {
  const id = Number(useParams().id);
  const [review, setReview] = useState<Review | null | undefined>();
  useEffect(() => {
    getJson<Review>(`/api/reviews/${id}`).then(setReview);
  }, [id]);
  usePageContext([{ description: "The review open on screen", value: JSON.stringify(review ?? "Loading") }]);
  if (!review) return <p>Loading…</p>;
  return (
    <article className="space-y-2 rounded-lg border p-4">
      <Link to="/" className="text-muted-foreground text-sm">← All reviews</Link>
      <h2 className="text-xl font-semibold">{review.title}</h2>
      <p className="text-muted-foreground text-sm">{review.author} · {"★".repeat(review.rating)}</p>
      <p>{review.review}</p>
    </article>
  );
}

// The form, reduced to what the spike needs: draft and proposal come from the
// agent's state, and accepting a suggestion writes back with setState.
function DraftPanel() {
  const state = useAgUiState<AgentState>();
  const setState = useAgUiSetState<AgentState>();
  const draft = state?.draft;
  if (!draft) return null;
  const proposal = state?.proposal ?? {};
  const accept = (field: keyof Draft) =>
    setState((s) => {
      const { [field]: value, ...rest } = s?.proposal ?? {};
      return { ...s, draft: { ...s!.draft!, [field]: value }, proposal: rest };
    });
  return (
    <section className="space-y-2 rounded-lg border p-4">
      <h3 className="font-semibold">Form {draft.id ? `(review #${draft.id})` : "(new)"}</h3>
      <pre data-testid="draft" className="bg-muted overflow-auto rounded p-2 text-xs">{JSON.stringify(draft, null, 1)}</pre>
      {Object.entries(proposal).map(([field, value]) => (
        <div key={field} className="flex items-center gap-2 text-sm">
          Suggested {field}: <b>{String(value)}</b>
          <Button size="sm" onClick={() => accept(field as keyof Draft)}>Accept</Button>
        </div>
      ))}
    </section>
  );
}

// show_reviews sets this; a URL param keeps the spike's state out of React context.
function useSearchQuery(): [string, (q: string) => void] {
  const navigate = useNavigate();
  const q = new URLSearchParams(location.search).get("q") ?? "";
  return [q, (next) => navigate(next ? `/?q=${encodeURIComponent(next)}` : "/")];
}

function Chat() {
  const navigate = useNavigate();
  const aui = useAui();
  const toolkit = defineToolkit({
    open_review: {
      description: "Show one review on its own page, by id. Use this when the user wants to see or read a review.",
      parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      execute: async ({ id }: { id: number }) => {
        const r = await getJson<Review>(`/api/reviews/${id}`);
        if (!r) return `There is no review #${id}.`;
        navigate(`/reviews/${id}`);
        return `Showing review #${id}: "${r.title}" by ${r.author}.`;
      },
    },
    show_reviews: {
      description:
        "Take the user to the list of reviews. `search` is what goes in the search box: free text plus " +
        'field filters (title:x, author:"le guin", genre:horror, rating:>=4). Returns how many are shown.',
      parameters: { type: "object", properties: { search: { type: "string" } } },
      execute: async ({ search }: { search?: string }) => {
        const q = (search ?? "").trim();
        navigate(q ? `/?q=${encodeURIComponent(q)}` : "/");
        const rows = (await getJson<Review[]>(`/api/reviews?q=${encodeURIComponent(q)}`)) ?? [];
        return rows.length ? `Showing ${rows.length} reviews: ${rows.slice(0, 10).map((r) => r.title).join(", ")}.` : `No reviews match "${q}".`;
      },
    },
  });
  const config = AuiConfig({
    tools: Tools({ toolkit }),
    suggestions: Suggestions([
      { title: "Open The Road", label: "frontend tool", prompt: "Open the review of The Road" },
      { title: "Horror reviews", label: "show_reviews", prompt: "Show me the horror reviews" },
    ]),
  });
  return (
    <AuiProvider extends={aui} config={config}>
      <Thread />
    </AuiProvider>
  );
}

export default function App() {
  return (
    <AgentProvider>
      <div className="grid h-dvh grid-cols-[1fr_420px]">
        <main className="space-y-4 overflow-auto p-6">
          <h1 className="text-2xl font-semibold"><Link to="/">Book Reviews</Link> <span className="text-muted-foreground text-sm">assistant-ui spike</span></h1>
          <DraftPanel />
          <Routes>
            <Route path="/" element={<ReviewList />} />
            <Route path="/reviews/:id" element={<ReviewPage />} />
          </Routes>
        </main>
        <aside className="h-dvh border-l"><Chat /></aside>
      </div>
    </AgentProvider>
  );
}

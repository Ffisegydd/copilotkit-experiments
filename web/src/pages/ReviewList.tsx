import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { AskPanel, useAsk } from "@/components/AskPanel";
import { useUi } from "@/components/AppShell";
import { Rating } from "@/components/Rating";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentContext } from "@/lib/agents";
import { useServices } from "@/lib/services";
import type { Review } from "@/lib/types";

export function ReviewList() {
  const { query, setQuery, askMode, setAskMode, reviewsVersion, editReview, removeReview } = useUi();
  const { api } = useServices();
  const [reviews, setReviews] = useState<Review[]>([]);
  const { agent: searchAgent, ask } = useAsk();
  // The box keeps the last question asked, so coming back from a cited
  // review shows what the answer was to.
  const asked = searchAgent.messages.find((m) => m.role === "user")?.content;
  const [question, setQuestion] = useState(typeof asked === "string" ? asked : "");
  const submit = (q: string) => {
    setQuestion(q);
    if (q.trim()) ask(q.trim());
  };

  const load = useCallback(
    async (q: string, signal?: AbortSignal) => setReviews(await api.listReviews(q, signal)),
    [api],
  );

  // Debounced search; aborting stops a slow earlier response overwriting a newer one.
  // reviewsVersion bumps after a save or delete so the list reloads.
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => load(query, ctrl.signal).catch(() => {}), query ? 250 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, reviewsVersion, load]);

  useAgentContext({
    description: "Reviews currently shown in the list (first 20)",
    value: reviews.slice(0, 20).map(({ id, title, author, genre, rating }) => ({ id, title, author, genre, rating })),
  });

  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (askMode) submit(question);
        }}
      >
        <div className="flex shrink-0 rounded-lg border p-0.5" role="group" aria-label="Search mode">
          <Button type="button" size="sm" variant={askMode ? "ghost" : "secondary"} aria-pressed={!askMode} onClick={() => setAskMode(false)}>
            Search
          </Button>
          <Button type="button" size="sm" variant={askMode ? "secondary" : "ghost"} aria-pressed={askMode} onClick={() => setAskMode(true)}>
            Ask
          </Button>
        </div>
        {askMode ? (
          <>
            <Input
              type="search"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about the reviews"
              aria-label="Ask a question about the reviews"
              autoFocus
            />
            {searchAgent.isRunning ? (
              <Button type="button" variant="outline" onClick={() => searchAgent.abortRun()}>
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={!question.trim()}>
                Ask
              </Button>
            )}
          </>
        ) : (
          <>
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search, or try genre:horror rating:>=4"
              aria-label="Search reviews"
            />
            {query.trim() && (
              <span className="text-muted-foreground shrink-0 text-sm">
                {reviews.length} {reviews.length === 1 ? "match" : "matches"}
              </span>
            )}
          </>
        )}
      </form>

      {askMode ? (
        <AskPanel onExample={submit} />
      ) : (
        <ul className="space-y-3">
          {reviews.map((r) => (
            <li key={r.id} className="bg-card space-y-3 rounded-xl border p-5">
              <div className="flex justify-between gap-3">
                <div>
                  <h3 className="font-semibold">
                    <Link to={`/reviews/${r.id}`} className="hover:underline">{r.title}</Link>
                  </h3>
                  <p className="text-muted-foreground text-sm">
                    {r.author}
                    {r.genre && ` · ${r.genre}`}
                    {r.reviewer && ` · reviewed by ${r.reviewer}`}
                  </p>
                </div>
                <Rating value={r.rating} />
              </div>
              <p className="line-clamp-3 leading-relaxed">{r.review}</p>
              <div className="flex justify-end gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to={`/reviews/${r.id}`}>Read</Link>
                </Button>
                <Button variant="outline" size="sm" onClick={() => editReview(r)}>
                  Edit
                </Button>
                <Button variant="outline" size="sm" className="text-destructive" onClick={() => removeReview(r)}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
          {reviews.length === 0 && (
            <li className="text-muted-foreground py-8 text-center">{query.trim() ? "No reviews match that search." : "No reviews yet."}</li>
          )}
        </ul>
      )}
    </>
  );
}

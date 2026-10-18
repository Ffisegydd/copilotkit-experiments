"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";
import { AskPanel, useAsk } from "@/components/AskPanel";
import { Rating } from "@/components/Rating";
import { useUi } from "@/components/AppShell";
import type { Review } from "@/lib/types";

export default function ReviewList() {
  const { query, setQuery, askMode, setAskMode, reviewsVersion, editReview, removeReview } = useUi();
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

  const load = useCallback(async (q: string, signal?: AbortSignal) => {
    const res = await fetch(`/api/reviews?q=${encodeURIComponent(q.trim())}`, { signal });
    setReviews(await res.json());
  }, []);

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
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (askMode) submit(question);
        }}
      >
        <div className="mode" role="group" aria-label="Search mode">
          <button type="button" aria-pressed={!askMode} onClick={() => setAskMode(false)}>
            Search
          </button>
          <button type="button" aria-pressed={askMode} onClick={() => setAskMode(true)}>
            Ask
          </button>
        </div>
        {askMode ? (
          <>
            <input
              type="search"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about the reviews"
              aria-label="Ask a question about the reviews"
              autoFocus
            />
            {searchAgent.isRunning ? (
              <button type="button" className="secondary" onClick={() => searchAgent.abortRun()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!question.trim()}>
                Ask
              </button>
            )}
          </>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search, or try genre:horror rating:>=4"
              aria-label="Search reviews"
            />
            {query.trim() && (
              <span className="meta">
                {reviews.length} {reviews.length === 1 ? "match" : "matches"}
              </span>
            )}
          </>
        )}
      </form>

      {askMode ? (
        <AskPanel onExample={submit} />
      ) : (
        <ul className="list">
          {reviews.map((r) => (
            <li key={r.id} className="card">
              <div className="item-head">
                <div>
                  <h3>
                    <Link href={`/reviews/${r.id}`}>{r.title}</Link>
                  </h3>
                  <p className="meta">
                    {r.author}
                    {r.genre && ` · ${r.genre}`}
                    {r.reviewer && ` · reviewed by ${r.reviewer}`}
                  </p>
                </div>
                <Rating value={r.rating} />
              </div>
              <p className="body clamp">{r.review}</p>
              <div className="actions">
                <Link className="button secondary" href={`/reviews/${r.id}`}>
                  Read
                </Link>
                <button className="secondary" onClick={() => editReview(r)}>
                  Edit
                </button>
                <button className="danger" onClick={() => removeReview(r)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
          {reviews.length === 0 && (
            <li className="empty">{query.trim() ? "No reviews match that search." : "No reviews yet."}</li>
          )}
        </ul>
      )}
    </>
  );
}

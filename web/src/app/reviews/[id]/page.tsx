"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAgentContext } from "@copilotkit/react-core/v2";
import { Rating } from "@/components/Rating";
import { useUi } from "@/components/AppShell";
import type { Review } from "@/lib/types";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export default function ReviewDetail() {
  const id = Number(useParams<{ id: string }>().id);
  // Set when arriving from a search answer's citation: the passage to mark.
  const quote = useSearchParams().get("quote");
  const { reviewsVersion, editReview, removeReview } = useUi();
  // undefined = loading, null = not found
  const [review, setReview] = useState<Review | null | undefined>(undefined);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/reviews/${id}`, { signal: ctrl.signal })
      .then(async (res) => setReview(res.ok ? await res.json() : null))
      .catch(() => {});
    return () => ctrl.abort();
  }, [id, reviewsVersion]);

  useAgentContext({
    description: "The review open on screen",
    value: review ?? (review === null ? `Review #${id} doesn't exist` : "Loading"),
  });

  if (review === undefined) return <p className="meta">Loading…</p>;

  return (
    <article className="detail">
      <Link className="back" href="/">
        ← All reviews
      </Link>

      {review === null ? (
        <p className="empty">There's no review #{id}. It may have been deleted.</p>
      ) : (
        <div className="card">
          <div className="item-head">
            <div>
              <h2>{review.title}</h2>
              <p className="meta">
                {review.author}
                {review.genre && ` · ${review.genre}`}
              </p>
            </div>
            <Rating value={review.rating} />
          </div>

          <p className="body">
            {review.review ? <Highlighted text={review.review} quote={quote} /> : <span className="meta">No review text.</span>}
          </p>

          <p className="meta">
            {review.reviewer ? `Reviewed by ${review.reviewer}` : "Reviewed"} on {formatDate(review.created_at)}
            {formatDate(review.updated_at) !== formatDate(review.created_at) &&
              ` · edited ${formatDate(review.updated_at)}`}
          </p>

          <div className="actions">
            <button className="secondary" onClick={() => editReview(review)}>
              Edit
            </button>
            <button className="danger" onClick={() => removeReview(review)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// The review text with `quote` marked and scrolled into view. The search agent
// copies quotes from the stored text exactly, so a plain indexOf finds them;
// if the review has been edited since, the text shows unmarked.
function Highlighted({ text, quote }: { text: string; quote: string | null }) {
  const mark = useRef<HTMLElement>(null);
  const at = quote ? text.indexOf(quote) : -1;
  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [at]);
  if (!quote || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark ref={mark}>{quote}</mark>
      {text.slice(at + quote.length)}
    </>
  );
}

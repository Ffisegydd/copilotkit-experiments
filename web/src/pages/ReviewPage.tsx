import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useUi } from "@/components/AppShell";
import { Rating } from "@/components/Rating";
import { Button } from "@/components/ui/button";
import { useAgentContext } from "@/lib/agents";
import { useServices } from "@/lib/services";
import type { Review } from "@/lib/types";

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

export function ReviewPage() {
  const id = Number(useParams().id);
  // Set when arriving from a search answer's citation: the passage to mark.
  const quote = useSearchParams()[0].get("quote");
  const { reviewsVersion, editReview, removeReview } = useUi();
  const { api } = useServices();
  // undefined = loading, null = not found
  const [review, setReview] = useState<Review | null | undefined>(undefined);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .getReview(id, ctrl.signal)
      .then(setReview)
      .catch(() => {});
    return () => ctrl.abort();
  }, [api, id, reviewsVersion]);

  useAgentContext({
    description: "The review open on screen",
    value: review ?? (review === null ? `Review #${id} doesn't exist` : "Loading"),
  });

  if (review === undefined) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <article className="space-y-3">
      <Link className="text-muted-foreground text-sm hover:underline" to="/">
        ← All reviews
      </Link>

      {review === null ? (
        <p className="text-muted-foreground py-8 text-center">There's no review #{id}. It may have been deleted.</p>
      ) : (
        <div className="bg-card space-y-4 rounded-xl border p-5">
          <div className="flex justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">{review.title}</h2>
              <p className="text-muted-foreground text-sm">
                {review.author}
                {review.genre && ` · ${review.genre}`}
              </p>
            </div>
            <Rating value={review.rating} />
          </div>

          <p className="leading-relaxed whitespace-pre-wrap">
            {review.review ? <Highlighted text={review.review} quote={quote} /> : <span className="text-muted-foreground">No review text.</span>}
          </p>

          <p className="text-muted-foreground text-sm">
            {review.reviewer ? `Reviewed by ${review.reviewer}` : "Reviewed"} on {formatDate(review.created_at)}
            {formatDate(review.updated_at) !== formatDate(review.created_at) && ` · edited ${formatDate(review.updated_at)}`}
          </p>

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => editReview(review)}>
              Edit
            </Button>
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => removeReview(review)}>
              Delete
            </Button>
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
      <mark ref={mark} className="bg-star/30 text-foreground rounded px-0.5">
        {quote}
      </mark>
      {text.slice(at + quote.length)}
    </>
  );
}

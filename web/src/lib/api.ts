import type { Draft, Review } from "@/lib/types";

// The api process's REST endpoints (agent/api.py), in one place. Created in
// main.tsx and reached through useServices().

export type SuggestionRequest = {
  messages: { role: string; text: string }[];
  tools: { name: string; description: string }[];
  screen: string;
};

export type Api = {
  /** The search box's query: free text plus field filters. */
  listReviews(q: string, signal?: AbortSignal): Promise<Review[]>;
  /** null if there's no review with that id. */
  getReview(id: number, signal?: AbortSignal): Promise<Review | null>;
  /** Creates the review, or updates it when the draft has an id. Throws
   * ApiError with the server's message if it's rejected. */
  saveReview(draft: Draft): Promise<Review>;
  deleteReview(id: number): Promise<void>;
  /** Follow-up prompts for the chat (agent/src/suggestions.py). */
  suggestions(req: SuggestionRequest, signal?: AbortSignal): Promise<string[]>;
};

export class ApiError extends Error {}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

const post = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function createApi(base = "/api"): Api {
  return {
    listReviews: (q, signal) => fetch(`${base}/reviews?q=${encodeURIComponent(q.trim())}`, { signal }).then(json<Review[]>),

    async getReview(id, signal) {
      const res = await fetch(`${base}/reviews/${id}`, { signal });
      return res.status === 404 ? null : json<Review>(res);
    },

    saveReview: (draft) =>
      fetch(draft.id ? `${base}/reviews/${draft.id}` : `${base}/reviews`, post(draft, draft.id ? "PUT" : "POST")).then(
        json<Review>,
      ),

    async deleteReview(id) {
      const res = await fetch(`${base}/reviews/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new ApiError(`Delete failed (${res.status})`);
    },

    async suggestions(req, signal) {
      const res = await fetch(`${base}/suggestions`, { ...post(req), signal });
      return (await json<{ suggestions: string[] }>(res)).suggestions;
    },
  };
}

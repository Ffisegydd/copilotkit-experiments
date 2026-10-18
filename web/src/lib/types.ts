export type Review = {
  id: number;
  title: string;
  author: string;
  genre: string | null;
  rating: number;
  review: string;
  reviewer: string | null;
  created_at: string;
  updated_at: string;
};

// The form being edited. Lives in the agent's shared state under `draft`, so
// both the user (typing) and the agent (update_draft tool) write to it.
// Must match `Draft` in agent/src/agent.py.
export type Draft = {
  id: number | null; // null = creating a new review
  title: string;
  author: string;
  genre: string;
  rating: number | null;
  review: string;
  reviewer: string;
};

// Everything the agent has put in the form, waiting for the user to accept
// or reject it (see `proposal` in agent/src/agent.py).
export type Proposal = Partial<Omit<Draft, "id">>;

export type AgentState = { draft?: Draft | null; proposal?: Proposal | null };

// The search agent's answer (agent/src/search_agent.py). Every citation has
// been checked: the review was retrieved during the run and the quote is
// copied from its text exactly as stored.
export type Citation = {
  n: number; // the [n] marker in the text
  id: number;
  title: string;
  author: string;
  rating: number;
  quote: string | null;
};

export type SearchAnswer = { text: string; citations: Citation[] };

export type SearchState = { answer?: SearchAnswer | null };

export const emptyDraft = (): Draft => ({
  id: null,
  title: "",
  author: "",
  genre: "",
  rating: null,
  review: "",
  reviewer: "",
});

export const draftFromReview = (r: Review): Draft => ({
  id: r.id,
  title: r.title,
  author: r.author,
  genre: r.genre ?? "",
  rating: r.rating,
  review: r.review,
  reviewer: r.reviewer ?? "",
});

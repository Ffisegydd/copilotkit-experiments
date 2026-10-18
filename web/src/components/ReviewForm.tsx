"use client";

import { acceptChange, diffSentences, rejectChange } from "@/lib/sentenceDiff";
import type { Draft, Proposal } from "@/lib/types";

type Props = {
  draft: Draft;
  // Everything the agent has put in the form, shown as tracked changes until
  // the user accepts or rejects them. That includes filling empty fields.
  proposal: Proposal | null;
  onChange: (next: Draft) => void;
  onReview: (next: Draft, proposal: Proposal | null) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  agentBusy: boolean;
};

type Field = keyof Proposal;

export function ReviewForm({ draft, proposal, onChange, onReview, onSave, onCancel, saving, error, agentBusy }: Props) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const pending = proposal ?? {};
  const without = (field: Field) => Object.fromEntries(Object.entries(pending).filter(([k]) => k !== field));

  // The agent's run ends by sending its state back, which would undo a
  // decision made mid-run, so suggestions wait until it's done.
  const accept = (field: Field) => onReview({ ...draft, [field]: pending[field] }, without(field));
  const reject = (field: Field) => onReview(draft, without(field));
  const acceptAll = () => onReview({ ...draft, ...pending }, null);
  const rejectAll = () => onReview(draft, null);

  const suggestion = (field: Exclude<Field, "review" | "rating">) =>
    pending[field] !== undefined && (
      <Suggestion
        onAccept={() => accept(field)}
        onReject={() => reject(field)}
        disabled={agentBusy}
      >
        <ins>{pending[field] || "(empty)"}</ins>
      </Suggestion>
    );

  return (
    <form
      className="card form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="form-head">
        <h2>{draft.id ? `Edit review #${draft.id}` : "New review"}</h2>
        {agentBusy && <span className="pill">Assistant is working…</span>}
      </div>

      {proposal && (
        <div className="suggest-bar">
          <span>The assistant suggested changes. Accept or reject them below; Save keeps only what you accept.</span>
          <span className="suggest-actions">
            <button type="button" className="secondary" onClick={rejectAll} disabled={agentBusy}>
              Reject all
            </button>
            <button type="button" onClick={acceptAll} disabled={agentBusy}>
              Accept all
            </button>
          </span>
        </div>
      )}

      <div className="row">
        <label>
          Title
          <input value={draft.title} onChange={(e) => set("title", e.target.value)} required />
          {suggestion("title")}
        </label>
        <label>
          Author
          <input value={draft.author} onChange={(e) => set("author", e.target.value)} required />
          {suggestion("author")}
        </label>
      </div>

      <div className="row">
        <label>
          Genre
          <input value={draft.genre} onChange={(e) => set("genre", e.target.value)} />
          {suggestion("genre")}
        </label>
        <label>
          Your name
          <input value={draft.reviewer} onChange={(e) => set("reviewer", e.target.value)} />
          {suggestion("reviewer")}
        </label>
      </div>

      <fieldset className="stars">
        <legend>Rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
            aria-pressed={draft.rating === n}
            className={draft.rating !== null && n <= draft.rating ? "on" : ""}
            onClick={() => set("rating", n)}
          >
            ★
          </button>
        ))}
        {pending.rating != null && (
          <Suggestion onAccept={() => accept("rating")} onReject={() => reject("rating")} disabled={agentBusy}>
            <ins className="rating">{"★".repeat(pending.rating)}</ins>
          </Suggestion>
        )}
      </fieldset>

      {pending.review !== undefined ? (
        <TrackedReview
          current={draft.review}
          suggested={pending.review}
          disabled={agentBusy}
          onAccept={(i) =>
            onReview({ ...draft, review: acceptChange(draft.review, pending.review!, i) }, pending)
          }
          onReject={(i) => onReview(draft, { ...pending, review: rejectChange(draft.review, pending.review!, i) })}
        />
      ) : (
        <label>
          Review
          <textarea rows={8} value={draft.review} onChange={(e) => set("review", e.target.value)} />
        </label>
      )}

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function Suggestion({
  children,
  onAccept,
  onReject,
  disabled,
}: {
  children: React.ReactNode;
  onAccept: () => void;
  onReject: () => void;
  disabled: boolean;
}) {
  return (
    <span className="suggestion">
      <span className="suggestion-label">Suggested</span>
      {children}
      <ChangeButtons onAccept={onAccept} onReject={onReject} disabled={disabled} />
    </span>
  );
}

function ChangeButtons({ onAccept, onReject, disabled }: { onAccept: () => void; onReject: () => void; disabled: boolean }) {
  return (
    <span className="change-buttons">
      <button type="button" className="accept" onClick={onAccept} disabled={disabled} aria-label="Accept" title="Accept">
        ✓
      </button>
      <button type="button" className="reject" onClick={onReject} disabled={disabled} aria-label="Reject" title="Reject">
        ✕
      </button>
    </span>
  );
}

// The review text with the agent's suggestion as tracked changes, a sentence
// at a time. Each change is accepted or rejected on its own; when none are
// left, the textarea comes back.
function TrackedReview({
  current,
  suggested,
  onAccept,
  onReject,
  disabled,
}: {
  current: string;
  suggested: string;
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="tracked">
      <span className="tracked-label">Review · suggested changes</span>
      <div className="tracked-text">
        {diffSentences(current, suggested).map((s, i) =>
          s.kind === "same" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i} className="change">
              {s.removed && <del>{s.removed}</del>}
              {s.added && <ins>{s.added}</ins>}
              <ChangeButtons onAccept={() => onAccept(s.index)} onReject={() => onReject(s.index)} disabled={disabled} />{" "}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

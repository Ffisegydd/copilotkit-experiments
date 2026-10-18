import { CheckIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
type TextField = Exclude<Field, "review" | "rating">;

const FIELDS: [TextField, string, boolean][] = [
  ["title", "Title", true],
  ["author", "Author", true],
  ["genre", "Genre", false],
  ["reviewer", "Your name", false],
];

export function ReviewForm({ draft, proposal, onChange, onReview, onSave, onCancel, saving, error, agentBusy }: Props) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value });
  const pending = proposal ?? {};
  const without = (field: Field) => Object.fromEntries(Object.entries(pending).filter(([k]) => k !== field));

  // The agent's run ends by sending its state back, which would undo a
  // decision made mid-run, so suggestions wait until it's done.
  const accept = (field: Field) => onReview({ ...draft, [field]: pending[field] }, without(field));
  const reject = (field: Field) => onReview(draft, without(field));

  return (
    <form
      className="bg-card space-y-4 rounded-xl border p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{draft.id ? `Edit review #${draft.id}` : "New review"}</h2>
        {agentBusy && <span className="bg-muted text-muted-foreground rounded-full px-2.5 py-0.5 text-xs">Assistant is working…</span>}
      </div>

      {proposal && (
        <div className="bg-muted/60 flex flex-wrap items-center justify-between gap-3 rounded-lg p-3 text-sm">
          <span>The assistant suggested changes. Accept or reject them below; Save keeps only what you accept.</span>
          <span className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onReview(draft, null)} disabled={agentBusy}>
              Reject all
            </Button>
            <Button type="button" size="sm" onClick={() => onReview({ ...draft, ...pending }, null)} disabled={agentBusy}>
              Accept all
            </Button>
          </span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map(([field, label, required]) => (
          <div key={field} className="space-y-1.5">
            <Label htmlFor={field}>{label}</Label>
            <Input id={field} value={draft[field]} onChange={(e) => set(field, e.target.value)} required={required} />
            {pending[field] !== undefined && (
              <Suggestion onAccept={() => accept(field)} onReject={() => reject(field)} disabled={agentBusy}>
                <Ins>{pending[field] || "(empty)"}</Ins>
              </Suggestion>
            )}
          </div>
        ))}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Rating</legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              type="button"
              key={n}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              aria-pressed={draft.rating === n}
              className={"text-2xl leading-none " + (draft.rating !== null && n <= draft.rating ? "text-star" : "text-muted-foreground/40")}
              onClick={() => set("rating", n)}
            >
              ★
            </button>
          ))}
        </div>
        {pending.rating != null && (
          <Suggestion onAccept={() => accept("rating")} onReject={() => reject("rating")} disabled={agentBusy}>
            <Ins>{"★".repeat(pending.rating)}</Ins>
          </Suggestion>
        )}
      </fieldset>

      {pending.review !== undefined ? (
        <TrackedReview
          current={draft.review}
          suggested={pending.review}
          disabled={agentBusy}
          onAccept={(i) => onReview({ ...draft, review: acceptChange(draft.review, pending.review!, i) }, pending)}
          onReject={(i) => onReview(draft, { ...pending, review: rejectChange(draft.review, pending.review!, i) })}
        />
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="review">Review</Label>
          <Textarea id="review" rows={8} value={draft.review} onChange={(e) => set("review", e.target.value)} />
        </div>
      )}

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const Ins = ({ children }: { children: ReactNode }) => (
  <ins className="rounded bg-emerald-500/15 px-1 text-emerald-800 no-underline dark:text-emerald-300">{children}</ins>
);

function Suggestion({ children, onAccept, onReject, disabled }: { children: ReactNode; onAccept: () => void; onReject: () => void; disabled: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground text-xs">Suggested</span>
      {children}
      <ChangeButtons onAccept={onAccept} onReject={onReject} disabled={disabled} />
    </span>
  );
}

function ChangeButtons({ onAccept, onReject, disabled }: { onAccept: () => void; onReject: () => void; disabled: boolean }) {
  return (
    <span className="inline-flex gap-0.5 align-middle">
      <Button type="button" variant="ghost" size="icon-xs" onClick={onAccept} disabled={disabled} aria-label="Accept" title="Accept">
        <CheckIcon />
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" onClick={onReject} disabled={disabled} aria-label="Reject" title="Reject">
        <XIcon />
      </Button>
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
    <div className="space-y-1.5">
      <span className="text-sm font-medium">Review · suggested changes</span>
      <div className="rounded-md border p-3 text-sm leading-relaxed whitespace-pre-wrap">
        {diffSentences(current, suggested).map((s, i) =>
          s.kind === "same" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span key={i}>
              {s.removed && <del className="bg-destructive/10 text-destructive rounded px-0.5">{s.removed}</del>}
              {s.added && <Ins>{s.added}</Ins>}
              <ChangeButtons onAccept={() => onAccept(s.index)} onReject={() => onReject(s.index)} disabled={disabled} />{" "}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

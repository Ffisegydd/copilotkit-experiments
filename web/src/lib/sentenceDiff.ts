// Sentence-level diff for the agent's suggested review text (see
// components/TrackedReview.tsx). Each changed run of sentences is a hunk the
// user accepts (into the draft) or rejects (out of the suggestion); once the
// two texts match, nothing is left to review.

export type Segment =
  | { kind: "same"; text: string }
  | { kind: "change"; index: number; removed: string; added: string };

type Hunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };

// A sentence with its trailing whitespace, or a run of blank lines, so
// joining the pieces gives back the text exactly.
export function sentences(text: string): string[] {
  return text.match(/[^.!?\n]+(?:[.!?]+["'”’)\]]*)?[ \t]*|[.!?]+[ \t]*|\n+/g) ?? [];
}

const key = (s: string) => s.trim();

function hunks(a: string[], b: string[]): Hunk[] {
  // Longest common subsequence over sentences, compared without whitespace.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = key(a[i]) === key(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      i++;
      j++;
      continue;
    }
    const start = { i, j };
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && key(a[i]) === key(b[j]))) {
      if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) i++;
      else j++;
    }
    out.push({ oldStart: start.i, oldEnd: i, newStart: start.j, newEnd: j });
  }
  return out;
}

/** The current text with each change from `current` to `suggested` marked. */
export function diffSentences(current: string, suggested: string): Segment[] {
  const a = sentences(current);
  const b = sentences(suggested);
  const segments: Segment[] = [];
  let i = 0;
  hunks(a, b).forEach((h, index) => {
    if (h.oldStart > i) segments.push({ kind: "same", text: a.slice(i, h.oldStart).join("") });
    segments.push({
      kind: "change",
      index,
      removed: a.slice(h.oldStart, h.oldEnd).join(""),
      added: b.slice(h.newStart, h.newEnd).join(""),
    });
    i = h.oldEnd;
  });
  if (i < a.length) segments.push({ kind: "same", text: a.slice(i).join("") });
  return segments;
}

// Joins pieces, adding a space where a sentence would otherwise run into the
// next one ("Good.Great.").
function join(parts: string[]): string {
  return parts.reduce((out, p) => (out && p && !/\s$/.test(out) && !/^\s/.test(p) ? `${out} ${p}` : out + p), "");
}

/** Applies change `index`: returns the new current text. */
export function acceptChange(current: string, suggested: string, index: number): string {
  const a = sentences(current);
  const b = sentences(suggested);
  const h = hunks(a, b)[index];
  if (!h) return current;
  return join([a.slice(0, h.oldStart).join(""), ...b.slice(h.newStart, h.newEnd), a.slice(h.oldEnd).join("")]).trimEnd();
}

/** Drops change `index`: returns the new suggested text. */
export function rejectChange(current: string, suggested: string, index: number): string {
  const a = sentences(current);
  const b = sentences(suggested);
  const h = hunks(a, b)[index];
  if (!h) return suggested;
  return join([b.slice(0, h.newStart).join(""), ...a.slice(h.oldStart, h.oldEnd), b.slice(h.newEnd).join("")]).trimEnd();
}

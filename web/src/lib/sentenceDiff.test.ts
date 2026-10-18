import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptChange, diffSentences, rejectChange, sentences } from "./sentenceDiff.ts";

const changes = (a: string, b: string) => diffSentences(a, b).filter((s) => s.kind === "change");

test("sentences keep their whitespace, so joining is lossless", () => {
  const text = 'Short. "Quoted!" she said.\n\nNew paragraph? Yes… no trailing stop';
  assert.equal(sentences(text).join(""), text);
  assert.deepEqual(sentences("One. Two."), ["One. ", "Two."]);
});

test("identical texts have no changes", () => {
  assert.deepEqual(diffSentences("A b. C d.", "A b. C d."), [{ kind: "same", text: "A b. C d." }]);
  assert.equal(changes("A b.  C d.", "A b. C d.").length, 0, "whitespace alone isn't a change");
});

test("a replaced sentence is one change between unchanged ones", () => {
  assert.deepEqual(diffSentences("One. Two. Three.", "One. Deux. Three."), [
    { kind: "same", text: "One. " },
    { kind: "change", index: 0, removed: "Two. ", added: "Deux. " },
    { kind: "same", text: "Three." },
  ]);
});

test("separate edits are separate changes", () => {
  const c = changes("One. Two. Three. Four.", "Uno. Two. Three. Quatre.");
  assert.equal(c.length, 2);
});

test("accepting a change applies only that one", () => {
  const cur = "One. Two. Three. Four.";
  const sug = "Uno. Two. Three. Quatre.";
  const next = acceptChange(cur, sug, 1);
  assert.equal(next, "One. Two. Three. Quatre.");
  assert.equal(changes(next, sug).length, 1);
});

test("rejecting a change removes it from the suggestion", () => {
  const cur = "One. Two. Three. Four.";
  const sug = "Uno. Two. Three. Quatre.";
  const next = rejectChange(cur, sug, 0);
  assert.equal(next, "One. Two. Three. Quatre.");
  assert.equal(changes(cur, next).length, 1);
});

test("additions and deletions at the ends", () => {
  assert.equal(acceptChange("Good book.", "Good book. Great ending.", 0), "Good book. Great ending.");
  assert.equal(acceptChange("Good book.", "Great start. Good book.", 0), "Great start. Good book.");
  assert.equal(acceptChange("Good book. Weak ending.", "Good book.", 0), "Good book.");
  assert.equal(acceptChange("", "Brand new text.", 0), "Brand new text.");
});

test("accepting every change in turn reaches the suggestion", () => {
  let cur = "The plot drags. Characters are thin. I liked the setting.";
  const sug = "The plot drags in the middle. I liked the setting. The ending is perfect.";
  while (changes(cur, sug).length) cur = acceptChange(cur, sug, 0);
  assert.equal(cur, sug);
});

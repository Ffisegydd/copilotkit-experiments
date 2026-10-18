"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { Rating } from "@/components/Rating";
import { LABELS, parseResult, summarise } from "@/components/ToolChip";
import type { Citation, SearchAnswer, SearchState } from "@/lib/types";

// The search agent (agent/src/search_agent.py, "search" in the runtime). It
// gets one question per run and no history: each ask replaces the last.
export const SEARCH_AGENT = "search";

const EXAMPLES = [
  "Which books did reviewers find slow to start but worth it?",
  "What do people say about endings?",
  "Which genre gets the best ratings?",
];

const STEP_LABELS: typeof LABELS = { ...LABELS, answer: ["Checking citations…", "Citations sent back"] };

type Step = { id: string; name: string; detail: string | null; done: boolean };

export const reviewLink = (c: Pick<Citation, "id" | "quote">) =>
  `/reviews/${c.id}${c.quote ? `?quote=${encodeURIComponent(c.quote)}` : ""}`;

/** Ask the search agent a question. Returns the agent and a function that
 * starts a fresh one-question run, stopping any run in progress. */
export function useAsk() {
  const { agent } = useAgent({ agentId: SEARCH_AGENT });
  const ask = (question: string) => {
    if (agent.isRunning) agent.abortRun();
    // A new thread per question: nothing carries over, and the runtime's
    // per-thread cache never fills up.
    agent.threadId = crypto.randomUUID();
    agent.setMessages([{ id: crypto.randomUUID(), role: "user", content: question }]);
    agent.setState({});
    // Straight to the agent rather than copilotkit.runAgent: no frontend tools
    // or app context to send, and no follow-up runs.
    agent.runAgent().catch(() => {}); // failures are reported via onRunFailed
  };
  return { agent, ask };
}

export function AskPanel({ onExample }: { onExample: (q: string) => void }) {
  const { agent } = useAgent({ agentId: SEARCH_AGENT });
  const question = agent.messages.find((m) => m.role === "user")?.content;
  const answer = (agent.state as SearchState | undefined)?.answer ?? null;

  // While the model writes its `answer` call, show the text as it arrives.
  // The tool's validated result (agent.state.answer) replaces it at the end.
  const [streamed, setStreamed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const sub = agent.subscribe({
      onRunInitialized: () => {
        setStreamed(null);
        setError(null);
      },
      onToolCallArgsEvent: ({ toolCallName, partialToolCallArgs }) => {
        if (toolCallName === "answer" && typeof partialToolCallArgs.text === "string") {
          setStreamed(partialToolCallArgs.text);
        }
      },
      onRunFailed: ({ error }) => {
        if (error.name !== "AbortError") setError(error.message || "The search failed.");
      },
    });
    return () => sub.unsubscribe();
  }, [agent]);

  if (!question) {
    return (
      <div className="ask-empty">
        <p className="meta">Ask a question and the agent will search the reviews and answer with quotes.</p>
        <div className="ask-examples">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" className="secondary" onClick={() => onExample(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const steps = searchSteps(agent.messages);
  const running = agent.isRunning;

  return (
    <section className="ask" aria-live="polite" aria-busy={running}>
      <div className="card ask-answer">
        <ol className="ask-steps">
          {steps.map((s) => (
            <li key={s.id} className={s.done ? "" : "running"}>
              <span>{(STEP_LABELS[s.name] ?? [s.name, s.name])[s.done ? 1 : 0]}</span>
              {s.detail && <span className="tool-detail">{s.detail}</span>}
            </li>
          ))}
          {running && steps.every((s) => s.done) && (
            <li className="running">{streamed === null ? (steps.length ? "Reading…" : "Thinking…") : "Writing the answer…"}</li>
          )}
        </ol>

        {error ? (
          <p className="error">{error}</p>
        ) : running ? (
          streamed && <p className="ask-text">{stripMarkers(streamed)}</p>
        ) : answer ? (
          <AnswerText answer={answer} />
        ) : (
          <p className="empty">The agent stopped without answering. Try asking again.</p>
        )}
      </div>

      {!running && answer && answer.citations.length > 0 && (
        <ol className="list ask-sources">
          {answer.citations.map((c) => (
            <li key={c.n} id={`cite-${c.n}`} className="card">
              <div className="item-head">
                <div>
                  <h3>
                    <span className="cite-n">{c.n}</span>
                    <Link href={reviewLink(c)}>{c.title}</Link>
                  </h3>
                  <p className="meta">{c.author}</p>
                </div>
                <Rating value={c.rating} />
              </div>
              {c.quote && <blockquote className="quote">{c.quote}</blockquote>}
              <div className="actions">
                <Link className="button secondary" href={reviewLink(c)}>
                  Read in context
                </Link>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// The answer with each [n] as a link to its review. Hovering or focusing one
// shows the quote it stands for.
function AnswerText({ answer }: { answer: SearchAnswer }) {
  const byN = new Map(answer.citations.map((c) => [c.n, c]));
  return (
    <p className="ask-text">
      {answer.text.split(/(\[\d+\])/).map((part, i) => {
        const c = byN.get(Number(part.match(/^\[(\d+)\]$/)?.[1]));
        if (!c) return part;
        return (
          <span key={i} className="cite">
            <Link href={reviewLink(c)} aria-label={`Source ${c.n}: ${c.title}`}>
              {c.n}
            </Link>
            <span className="cite-pop" role="tooltip">
              {c.quote && <q>{c.quote}</q>}
              <span className="meta">
                {c.title}, {c.author}
              </span>
            </span>
          </span>
        );
      })}
    </p>
  );
}

// Markers mid-stream may point at citations that change or get dropped when
// the answer is checked, so they're hidden until then.
const stripMarkers = (text: string) => text.replace(/\s*\[\d*\]?/g, "");

type AnyMessage = {
  id: string;
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: { id: string; function: { name: string; arguments: string } }[];
};

// The agent's search and SQL calls so far, for the progress list, plus any
// answer the agent's citation check sent back to be fixed.
function searchSteps(messages: readonly AnyMessage[]): Step[] {
  const results = new Map(
    messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, String(m.content ?? "")]),
  );
  return messages
    .flatMap((m) => m.toolCalls ?? [])
    .flatMap((tc): Step[] => {
      const result = results.get(tc.id);
      if (tc.function.name === "answer") {
        // In progress or accepted: the answer itself shows that.
        if (result === undefined || result.startsWith("Answer shown")) return [];
        const fixes = result.split("\n").length - 1;
        return [{ id: tc.id, name: "answer", detail: `${fixes} to fix`, done: true }];
      }
      let args = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {} // still streaming
      return [
        {
          id: tc.id,
          name: tc.function.name,
          detail: summarise(tc.function.name, args, parseResult(result)),
          done: result !== undefined,
        },
      ];
    });
}

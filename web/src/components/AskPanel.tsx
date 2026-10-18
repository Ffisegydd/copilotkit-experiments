import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Rating } from "@/components/Rating";
import { LABELS, parseResult, summarise } from "@/components/ToolChip";
import { searchAgent, useAgentUpdates } from "@/lib/agents";
import type { Citation, SearchAnswer, SearchState } from "@/lib/types";

// The search agent (agent/src/search_agent.py). It gets one question per run
// and no history: each ask replaces the last. The page drives it directly
// with @ag-ui/client; it isn't a chat, so assistant-ui isn't involved.

const EXAMPLES = [
  "Which books did reviewers find slow to start but worth it?",
  "What do people say about endings?",
  "Which genre gets the best ratings?",
];

const STEP_LABELS: typeof LABELS = { ...LABELS, answer: ["Checking citations…", "Citations sent back"] };

type Step = { id: string; name: string; detail: string | null; done: boolean };

export const reviewLink = (c: Pick<Citation, "id" | "quote">) =>
  `/reviews/${c.id}${c.quote ? `?quote=${encodeURIComponent(c.quote)}` : ""}`;

/** Ask the search agent a question: a fresh one-question run, stopping any
 * run in progress. */
export function useAsk() {
  useAgentUpdates(searchAgent);
  const ask = (question: string) => {
    if (searchAgent.isRunning) searchAgent.abortRun();
    // A new thread per question: nothing carries over.
    searchAgent.threadId = crypto.randomUUID();
    searchAgent.setMessages([{ id: crypto.randomUUID(), role: "user", content: question }]);
    searchAgent.setState({});
    searchAgent.runAgent().catch(() => {}); // failures are reported via onRunFailed
  };
  return { agent: searchAgent, ask };
}

export function AskPanel({ onExample }: { onExample: (q: string) => void }) {
  const agent = searchAgent;
  useAgentUpdates(agent);
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
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">Ask a question and the agent will search the reviews and answer with quotes.</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((q) => (
            <Button key={q} type="button" variant="outline" size="sm" onClick={() => onExample(q)}>
              {q}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const steps = searchSteps(agent.messages);
  const running = agent.isRunning;

  return (
    <section className="space-y-3" aria-live="polite" aria-busy={running}>
      <div className="bg-card space-y-3 rounded-xl border p-5">
        <ol className="text-muted-foreground space-y-1 text-sm">
          {steps.map((s) => (
            <li key={s.id} className={s.done ? "" : "animate-pulse"}>
              <span className="text-foreground">{(STEP_LABELS[s.name] ?? [s.name, s.name])[s.done ? 1 : 0]}</span>
              {s.detail && <span className="ml-2">{s.detail}</span>}
            </li>
          ))}
          {running && steps.every((s) => s.done) && (
            <li className="animate-pulse">{streamed === null ? (steps.length ? "Reading…" : "Thinking…") : "Writing the answer…"}</li>
          )}
        </ol>

        {error ? (
          <p className="text-destructive">{error}</p>
        ) : running ? (
          streamed && <p className="leading-relaxed">{stripMarkers(streamed)}</p>
        ) : answer ? (
          <AnswerText answer={answer} />
        ) : (
          <p className="text-muted-foreground">The agent stopped without answering. Try asking again.</p>
        )}
      </div>

      {!running && answer && answer.citations.length > 0 && (
        <ol className="space-y-3">
          {answer.citations.map((c) => (
            <li key={c.n} id={`cite-${c.n}`} className="bg-card space-y-3 rounded-xl border p-5">
              <div className="flex justify-between gap-3">
                <div>
                  <h3 className="font-semibold">
                    <CiteN n={c.n} />
                    <Link to={reviewLink(c)} className="hover:underline">{c.title}</Link>
                  </h3>
                  <p className="text-muted-foreground text-sm">{c.author}</p>
                </div>
                <Rating value={c.rating} />
              </div>
              {c.quote && <blockquote className="border-primary border-l-2 pl-3 italic">{c.quote}</blockquote>}
              <Button asChild variant="outline" size="sm">
                <Link to={reviewLink(c)}>Read in context</Link>
              </Button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const CiteN = ({ n }: { n: number }) => (
  <span className="bg-primary text-primary-foreground mr-2 inline-grid size-5 place-items-center rounded-full align-[2px] text-[11px] font-semibold">
    {n}
  </span>
);

// The answer with each [n] as a link to its review. Hovering or focusing one
// shows the quote it stands for.
function AnswerText({ answer }: { answer: SearchAnswer }) {
  const byN = new Map(answer.citations.map((c) => [c.n, c]));
  return (
    <p className="leading-relaxed">
      {answer.text.split(/(\[\d+\])/).map((part, i) => {
        const c = byN.get(Number(part.match(/^\[(\d+)\]$/)?.[1]));
        if (!c) return part;
        return (
          <span key={i} className="group relative">
            <Link
              to={reviewLink(c)}
              aria-label={`Source ${c.n}: ${c.title}`}
              className="bg-primary/15 text-primary mx-0.5 inline-grid size-5 place-items-center rounded-full align-[2px] text-[11px] font-semibold"
            >
              {c.n}
            </Link>
            <span
              role="tooltip"
              className="bg-popover text-popover-foreground invisible absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 space-y-1 rounded-lg border p-3 text-sm shadow-md group-focus-within:visible group-hover:visible"
            >
              {c.quote && <q className="block italic">{c.quote}</q>}
              <span className="text-muted-foreground block">
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

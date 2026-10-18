"use client";

import Link from "next/link";
import { useDefaultRenderTool } from "@copilotkit/react-core/v2";

type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

export const LABELS: Record<string, [running: string, done: string]> = {
  search_reviews: ["Searching reviews…", "Searched reviews"],
  run_readonly_sql: ["Querying the database…", "Queried the database"],
  update_draft: ["Updating the form…", "Updated the form"],
  show_reviews: ["Opening the review list…", "Opened the review list"],
  open_review: ["Opening the review…", "Opened the review"],
  edit_review: ["Opening the editor…", "Opened the editor"],
};

// Backend tools return JSON (lists of rows); frontend tools and errors return
// plain sentences. Parse when we can, otherwise keep the text.
export function parseResult(result: string | undefined): unknown {
  if (result === undefined) return undefined;
  try {
    return JSON.parse(result);
  } catch {
    return result;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Curly quotes, so a query that has its own quotes (author:"le guin") stays readable.
const quoted = (v: unknown) => (typeof v === "string" && v.trim() ? `“${v.trim()}”` : null);

// search_reviews' filter arguments, written the way the search box takes them.
function searchFilters(args: Args): string | null {
  const val = (v: unknown) => (/\s/.test(String(v)) ? `"${v}"` : String(v));
  const parts: string[] = [];
  for (const field of ["title", "author", "genre", "reviewer"]) {
    if (args[field]) parts.push(`${field}:${val(args[field])}`);
    for (const v of (args[`exclude_${field}s`] as unknown[] | undefined) ?? []) parts.push(`-${field}:${val(v)}`);
  }
  const [min, max] = [args.min_rating, args.max_rating];
  if (min && min === max) parts.push(`rating:${min}`);
  else {
    if (min) parts.push(`rating:>=${min}`);
    if (max) parts.push(`rating:<=${max}`);
  }
  return parts.join(" ") || null;
}

// The short text after the label on the collapsed line.
export function summarise(name: string, args: Args, result: unknown): string | null {
  const rows = Array.isArray(result) ? (result as Row[]) : null;
  switch (name) {
    case "search_reviews": {
      const what = [quoted(args.query), searchFilters(args)].filter(Boolean).join(", ");
      const found = rows ? plural(rows.length, "result") : typeof result === "string" ? "no matches" : null;
      return [what || "newest", found].filter(Boolean).join(" · ");
    }
    case "run_readonly_sql":
      // The tool's own error messages; see run_readonly_sql in agent/src/agent.py.
      return rows
        ? plural(rows.length, "row")
        : typeof result === "string" && /^(Query failed|Only a single)/.test(result)
          ? "failed"
          : null;
    case "update_draft":
      return Object.keys(args).join(", ") || null;
    case "open_review":
    case "edit_review":
      return args.id !== undefined ? `#${args.id}` : null;
    case "show_reviews":
      return quoted(args.search) ?? (args.search === "" ? "filter cleared" : null);
    default:
      return null;
  }
}

function ArgList({ args }: { args: Args }) {
  const entries = Object.entries(args).filter(([, v]) => v !== null && v !== undefined);
  if (!entries.length) return <p className="tool-muted">No arguments.</p>;
  return (
    <dl className="tool-args">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewHits({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p className="tool-muted">No matches.</p>;
  return (
    <ol className="tool-hits">
      {rows.map((r) => (
        <li key={String(r.id)}>
          <Link href={`/reviews/${r.id}`}>{String(r.title)}</Link>
          <span className="tool-muted">
            {" "}
            {String(r.author)} · {"★".repeat(Number(r.rating))}
            {typeof r.score === "number" && r.score > 0 && ` · score ${r.score}`}
          </span>
        </li>
      ))}
    </ol>
  );
}

const MAX_TABLE_ROWS = 20;

function RowsTable({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p className="tool-muted">No rows.</p>;
  const columns = Object.keys(rows[0]);
  return (
    <div className="tool-table">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_TABLE_ROWS).map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c} title={String(row[c] ?? "")}>
                  {row[c] === null ? <span className="tool-muted">null</span> : String(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_TABLE_ROWS && (
        <p className="tool-muted">…and {plural(rows.length - MAX_TABLE_ROWS, "more row")}</p>
      )}
    </div>
  );
}

function ResultView({ name, result }: { name: string; result: unknown }) {
  if (result === undefined) return <p className="tool-muted">Waiting for the result…</p>;
  if (typeof result === "string") return <p className="tool-text">{result}</p>;
  if (Array.isArray(result)) {
    return name === "search_reviews" ? <ReviewHits rows={result as Row[]} /> : <RowsTable rows={result as Row[]} />;
  }
  return <pre className="tool-code">{JSON.stringify(result, null, 2)}</pre>;
}

function ToolBody({ name, args, result }: { name: string; args: Args; result: unknown }) {
  if (name === "run_readonly_sql") {
    return (
      <>
        <pre className="tool-code">{String(args.sql ?? "")}</pre>
        <ResultView name={name} result={result} />
      </>
    );
  }
  return (
    <>
      <ArgList args={args} />
      <ResultView name={name} result={result} />
    </>
  );
}

// Renders each agent tool call in the chat as a one-line chip that expands to
// show what the tool was asked and what it returned.
export function useToolChips() {
  useDefaultRenderTool({
    render: ({ name, status, parameters, result }) => {
      const [running, done] = LABELS[name] ?? [`Running ${name}…`, `Ran ${name}`];
      const complete = status === "complete";
      // Arguments stream in while the model writes them, so they may be partial.
      const args = (parameters && typeof parameters === "object" ? parameters : {}) as Args;
      const parsed = parseResult(result);
      const detail = summarise(name, args, parsed);
      return (
        <details className="tool-call">
          <summary className={complete ? "tool-chip" : "tool-chip running"}>
            <span>{complete ? done : running}</span>
            {detail && <span className="tool-detail">{detail}</span>}
          </summary>
          <div className="tool-body">
            <ToolBody name={name} args={args} result={complete ? parsed : undefined} />
          </div>
        </details>
      );
    },
  });
}

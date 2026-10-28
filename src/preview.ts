import { extract, type ExtractedQuery } from "./extract.ts";
import { render } from "./parts.ts";
import { validatePlaceholders } from "./validate.ts";

export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export function offset(text: string, position: Position) {
  if (position.line < 0 || position.character < 0) return 0;
  let start = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf("\n", start);
    if (next < 0) return text.length;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return Math.min(start + position.character, end < 0 ? text.length : end);
}
export function position(text: string, at: number): Position {
  const prefix = text.slice(0, at);
  const end = prefix.lastIndexOf("\n");
  return { line: prefix.split("\n").length - 1, character: at - end - 1 };
}
function fence(text: string, language = "") {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}\n${text}\n${marks}`;
}
function unindent(sql: string) {
  const lines = sql
    .replace(/^\s*\n/, "")
    .trimEnd()
    .split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((line) => line.slice(indent)).join("\n");
}

export function queryMarkdown(q: ExtractedQuery, generated = false): string {
  const header = [
    `**Inline SQL: ${q.id.replace(/[\\*_`[\]<>]/g, "\\$&")}**`,
    generated
      ? "Generated preview from the last successful analysis. Regenerate after SQL/schema edits."
      : "Live source preview. SQL validation appears separately in editor diagnostics. Run `bun run typecheck` for SQL and TypeScript checking.",
    `${q.alternatives.length} possible source path(s). Conditions and values are not evaluated; paths may be unreachable.`,
  ];
  const blocks: string[] = [];
  let length = header.join("\n\n").length;
  for (const [i, variant] of q.alternatives.entries()) {
    if (i >= 8) break;
    validatePlaceholders(variant.parts);
    const expressions = variant.parts.flatMap((p) =>
      typeof p === "string" ? [] : [p.expression ?? "parameter"],
    );
    const block = [
      `**Alternative ${i + 1}**`,
      variant.conditions.length
        ? fence(variant.conditions.join("\n"), "text")
        : "Unconditional SQL structure.",
      fence(unindent(render(variant.parts).text), "sql"),
      expressions.length
        ? "Bindings (source expressions, never evaluated):\n\n" +
          fence(expressions.map((e, j) => `$${j + 1} ← ${e}`).join("\n"), "text")
        : "No bindings.",
    ].join("\n\n");
    if (length + block.length > 24_000) break;
    blocks.push(block);
    length += block.length;
  }
  if (blocks.length < q.alternatives.length)
    blocks.push(
      `Preview limited: showing ${blocks.length} of ${q.alternatives.length} paths. Use the inspection command for all paths.`,
    );
  return [...header, ...blocks].join("\n\n");
}

// Document contents are supplied by the editor. No filesystem reads, DB, eval,
// imports of application modules, or connections are needed to preview a query.
export class PreviewService {
  readonly documents = new Map<string, string>();
  private cache = new Map<string, { text: string; queries?: ExtractedQuery[]; error?: string }>();
  parses = 0;
  close(uri: string) {
    this.documents.delete(uri);
    this.cache.delete(uri);
  }
  hover(uri: string, at: Position) {
    const text = this.documents.get(uri);
    if (text === undefined || text.length > 500_000 || !text.includes(".inline/sql")) return null;
    let cached = this.cache.get(uri);
    if (cached?.text !== text) {
      this.parses++;
      cached = { text };
      try {
        cached.queries = extract(text, uri);
      } catch (error) {
        cached.error = error instanceof Error ? error.message : String(error);
      }
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(uri, cached);
    }
    if (cached.error)
      return {
        contents: {
          kind: "markdown",
          value: "**Inline SQL preview unavailable**\n\n" + fence(cached.error, "text"),
        },
      };
    const point = offset(text, at);
    const query = cached.queries?.find((q) => point >= q.start && point < q.end);
    if (!query) return null;
    let value: string;
    try {
      value = queryMarkdown(query);
    } catch (error) {
      value = "**Inline SQL preview unavailable**\n\n" + fence(String(error), "text");
    }
    return {
      contents: { kind: "markdown", value },
      // Limit the hover's range to the queried character so moving between a
      // parameter's TS type and the query tag doesn't cache a whole-template range.
      range: { start: position(text, point), end: position(text, Math.min(point + 1, query.end)) },
    };
  }
}

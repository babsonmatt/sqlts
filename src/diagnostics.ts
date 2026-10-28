import { tokens } from "./adapter/lex.ts";
import { resolve } from "node:path";
import { extract } from "./extract.ts";
import { render } from "./parts.ts";
import { position, type Range } from "./preview.ts";
import { validatePlaceholders } from "./validate.ts";
import type { Diagnostic, Handlers } from "./adapter/reylo.ts";

export interface SqlDiagnostic {
  range: Range;
  severity: 1 | 2;
  source: "reylo-inline";
  message: string;
  code?: number;
}
export function diagnosticRange(
  source: string,
  sql: string,
  map: readonly (number | undefined)[],
  diagnostic: Diagnostic,
  fallback: number,
): Range {
  const bytes = Buffer.from(sql);
  let start = bytes.subarray(0, diagnostic.start).toString("utf8").length;
  let end = bytes.subarray(0, diagnostic.start + diagnostic.length).toString("utf8").length;
  // Reylo 0.5 can misplace PostgreSQL refusals after non-ASCII SQL. Only repair
  // an unknown-column location when the named column has one unambiguous token.
  const missing = /column (?:"([^"]+)"|([\w.]+)) does not exist/.exec(diagnostic.messageText);
  if (missing) {
    const name = missing[1] ?? missing[2]!.split(".").at(-1)!;
    const matches = tokens(sql).flatMap((token) => {
      if (token.kind === "comment" || (token.kind === "quoted" && !token.text.startsWith('"')))
        return [];
      return [...token.text.matchAll(/"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*/gu)]
        .filter((m) => m[0] === name || m[0] === `"${name.replaceAll('"', '""')}"`)
        .map((m) => ({ text: m[0], index: token.start + m.index }));
    });
    const nearby = matches.find((m) => m.index >= start && m.index < end);
    const target = nearby ?? (matches.length === 1 ? matches[0] : undefined);
    if (target) {
      start = target.index;
      end = start + target.text.length;
    }
  }
  const points = map
    .slice(start, Math.max(start + 1, end))
    .filter((p): p is number => p !== undefined);
  const first = points[0] ?? fallback;
  const last = points.at(-1) ?? first;
  const escape = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[^\r\n])/.exec(
    source.slice(last),
  );
  const sourceEnd = last + (escape?.[0].length ?? 1);
  return { start: position(source, first), end: position(source, Math.max(first + 1, sourceEnd)) };
}

/** Analyze editor text without executing application code or replacing generated types. */
export async function diagnose(
  source: string,
  file: string,
  handlers: Handlers,
  projectHandle: string,
): Promise<SqlDiagnostic[]> {
  const diagnostics: SqlDiagnostic[] = [];
  let queries;
  try {
    queries = extract(source, file);
  } catch (error) {
    return [
      {
        range: { start: position(source, 0), end: position(source, 1) },
        severity: 1,
        source: "reylo-inline",
        message: String(error),
      },
    ];
  }
  const cached = new Map<string, Awaited<ReturnType<Handlers["transform"]>>>();
  for (const q of queries) {
    for (const [i, parts] of q.variants.entries()) {
      try {
        validatePlaceholders(parts);
        const sql = render(parts).named;
        let result = cached.get(sql);
        if (!result) {
          if (cached.size >= 256)
            throw new Error(
              "Editor validation limited to 256 SQL shapes per document; split this file or run the CLI check.",
            );
          result = await handlers.transform({
            projectHandle,
            fileName: resolve(".inline", "editor.sql"),
            content: sql,
          });
          cached.set(sql, result);
        }
        for (const d of result.diagnostics) {
          diagnostics.push({
            range: diagnosticRange(source, sql, q.sourceMaps[i]!, d, q.start),
            severity: 1,
            source: "reylo-inline",
            message: `${q.id}: ${d.messageText}`,
            code: d.code,
          });
        }
      } catch (error) {
        diagnostics.push({
          range: { start: position(source, q.start), end: position(source, q.tagEnd) },
          severity: 1,
          source: "reylo-inline",
          message: `${q.id}: ${String(error)}`,
        });
        break;
      }
    }
  }
  return [...new Map(diagnostics.map((d) => [JSON.stringify(d), d])).values()];
}

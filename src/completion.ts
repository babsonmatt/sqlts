import { lex } from "./sql-lex.ts";
import { SqlScopes } from "./sql-scopes.ts";
import ts from "typescript-ast";
import { extract, type ExtractedQuery } from "./extract.ts";
import { render } from "./parts.ts";
import { prepare, mapOffset } from "./sqlts/transform.ts";
import { offset, position, type Position, type Range } from "./preview.ts";
import type { Catalog } from "./catalog.ts";

interface Context {
  sql: string;
  at: number;
  map: readonly (number | undefined)[];
}
export interface CompletionItem {
  label: string;
  kind: number;
  detail: string;
  filterText: string;
  textEdit: { range: Range; newText: string };
}
export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

function quote(name: string, catalog: Catalog) {
  return /^[a-z_][a-z_0-9$]*$/.test(name) && !catalog.keywords.includes(name)
    ? name
    : `"${name.replaceAll('"', '""')}"`;
}
// SQL text goes back into a JS template; escape template delimiters, not SQL values.
const templateText = (text: string) =>
  text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");

function candidates(
  context: Context,
  source: string,
  cursor: number,
  catalog: Catalog,
): CompletionItem[] {
  const all = lex(context.sql);
  if (all.some((t) => t.kind === "hidden" && t.start <= context.at && context.at <= t.end))
    return [];
  const tokens = all.filter((t) => t.kind !== "hidden");
  const partial = tokens.find(
    (t) => t.kind === "id" && t.start < context.at && context.at <= t.end,
  );
  const typed = partial ? context.sql.slice(partial.start, context.at) : "";
  const prefix = typed.startsWith('"')
    ? typed.slice(1).replaceAll('""', '"').replace(/"$/, "")
    : typed.toLowerCase();
  const sqlStart = partial?.start ?? context.at;
  const sqlEnd = partial?.end ?? context.at;
  const first = partial ? context.map[sqlStart] : cursor;
  const last = partial ? context.map[sqlEnd - 1] : cursor - 1;
  if (first === undefined || last === undefined) return [];
  const range = { start: position(source, first), end: position(source, last + 1) };
  const before = tokens.filter((t) => t.end <= sqlStart);
  const dot = before.at(-1)?.text === ".";
  const qualifier = dot ? before.at(-2) : undefined;
  const previous = before.at(dot ? -3 : -1);
  const model = new SqlScopes(context.sql, catalog);
  const scope = model.at(context.at);
  if (!scope) return [];
  const mode = model.mode(scope, sqlStart, previous);
  if (mode === "none") return [];
  const bindings =
    mode === "value"
      ? []
      : mode === "target"
        ? scope.target
          ? [scope.target]
          : []
        : model.bindingsAt(scope, context.at);
  if (mode === "target" && dot) return [];
  const ctes = scope.ctes;
  const relationContext = mode === "relation";
  const items: CompletionItem[] = [];
  const add = (label: string, name: string, insert: string, kind: number, detail: string) => {
    if (!name.toLowerCase().startsWith(prefix.toLowerCase())) return;
    items.push({
      label,
      kind,
      detail,
      filterText: dot ? `${qualifier!.text}.${name}` : name,
      textEdit: { range, newText: templateText(insert) },
    });
  };
  if (relationContext) {
    if (!dot)
      for (const schema of catalog.schemas)
        add(schema, schema, quote(schema, catalog), 9, "PostgreSQL schema");
    if (!dot)
      for (const [name, cte] of ctes)
        add(
          name,
          name,
          quote(name, catalog),
          7,
          `CTE · ${cte.columns.map((c) => c.name).join(", ")}`,
        );
    for (const r of catalog.relations) {
      if (!r.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      if (!dot && ctes.has(r.name) && r.visible) continue;
      if (dot && r.schema !== qualifier?.name) continue;
      const text =
        dot || r.visible
          ? quote(r.name, catalog)
          : `${quote(r.schema, catalog)}.${quote(r.name, catalog)}`;
      add(
        dot || r.visible ? r.name : `${r.schema}.${r.name}`,
        r.name,
        text,
        7,
        `Table/view · ${r.schema}.${r.name}`,
      );
    }
  } else {
    if (dot && qualifier?.kind !== "id") return [];
    for (const binding of bindings) {
      if (dot && binding.alias !== qualifier!.name) continue;
      for (const c of binding.relation.columns) {
        const duplicate =
          !dot &&
          bindings.filter((b) => b.relation.columns.some((v) => v.name === c.name)).length > 1;
        const insert = duplicate
          ? `${quote(binding.alias, catalog)}.${quote(c.name, catalog)}`
          : quote(c.name, catalog);
        add(
          duplicate ? `${binding.alias}.${c.name}` : c.name,
          c.name,
          insert,
          5,
          `${c.type} · ${binding.relation.origin ?? "table"} ${c.nullable === null ? "(nullability not inferred)" : c.nullable ? "nullable" : "NOT NULL"} · ${binding.relation.schema ? binding.relation.schema + "." : ""}${binding.relation.name}`,
        );
      }
    }
  }
  if (mode !== "target" && (!dot || !bindings.some((b) => b.alias === qualifier?.name))) {
    for (const f of catalog.functions ?? []) {
      if (!f.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      if (dot ? f.schema !== qualifier?.name : !f.visible) continue;
      add(
        f.name,
        f.name,
        quote(f.name, catalog),
        3,
        `${f.schema}.${f.name}(${f.arguments}) → ${f.result}`,
      );
    }
  }
  return items;
}

/** Pure completion: cached catalog plus current editor text, with no database I/O. */
export class CompletionService {
  private cache = new Map<
    string,
    { source: string; queries: ExtractedQuery[]; literals: { start: number; end: number }[] }
  >();
  close(file: string) {
    this.cache.delete(file);
  }
  private contexts(source: string, file: string, at: Position): Context[] {
    const empty: Context[] = [];
    if (source.length > 500000) return empty;
    let entry = this.cache.get(file);
    if (!entry || entry.source !== source) {
      try {
        // Keep all completion edits in authored coordinates, including nested fragments.
        let queries: ExtractedQuery[];
        if (file.endsWith(".sqlts")) {
          const prepared = prepare(source, file, true);
          const original = (at: number) => mapOffset(prepared.analysis, at, true);
          queries = prepared.queries.map((query) => ({
            ...query,
            start: original(query.start),
            end: original(query.end),
            tagEnd: original(query.tagEnd),
            sourceMaps: query.sourceMaps.map((map) =>
              map.map((at) => (at === undefined ? undefined : original(at))),
            ),
          }));
        } else queries = extract(source, file, 64, true);
        const literals: { start: number; end: number }[] = [];
        const sf = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const visit = (node: ts.Node) => {
          if (ts.isTemplateLiteralToken(node))
            literals.push({
              start: node.getStart(sf) + 1,
              end:
                node.end -
                (node.kind === ts.SyntaxKind.TemplateHead ||
                node.kind === ts.SyntaxKind.TemplateMiddle
                  ? 2
                  : node.isUnterminated
                    ? 0
                    : 1),
            });
          ts.forEachChild(node, visit);
        };
        visit(sf);
        entry = { source, queries, literals };
        if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(file, entry);
      } catch {
        return empty;
      }
    }
    const cursor = offset(source, at);
    const literal = entry.literals.find((l) => cursor >= l.start && cursor <= l.end);
    if (!literal) return empty;
    const query = entry.queries.find((q) => cursor >= q.start && cursor <= q.end);
    if (!query) return empty;
    const contexts: Context[] = [];
    for (const [i, parts] of query.variants.entries()) {
      const map = query.sourceMaps[i]!;
      let atSql = map.findIndex((p) => p === cursor && p >= literal.start && p < literal.end);
      if (atSql < 0) {
        const last = map.findLastIndex((p) => p !== undefined && p >= literal.start && p < cursor);
        if (last < 0) continue;
        atSql = last + 1;
      }
      contexts.push({ sql: render(parts).named, at: atSql, map });
    }
    return contexts;
  }
  functionHover(source: string, file: string, at: Position, catalog: Catalog) {
    const context = this.contexts(source, file, at)[0];
    if (!context) return null;
    const tokens = lex(context.sql);
    const index = tokens.findIndex(
      (t) => t.kind === "id" && t.start <= context.at && t.end >= context.at,
    );
    const name = tokens[index];
    if (!name || tokens[index + 1]?.text !== "(") return null;
    const schema = tokens[index - 1]?.text === "." ? tokens[index - 2]?.name : undefined;
    const functions = (catalog.functions ?? []).filter(
      (f) => f.name === name.name && (schema ? f.schema === schema : f.visible),
    );
    if (!functions.length) return null;
    const lines = functions
      .slice(0, 30)
      .map((f) => `${f.schema}.${f.name}(${f.arguments}) → ${f.result}`)
      .join("\n")
      .slice(0, 24000);
    const fence = "`".repeat(
      Math.max(3, ...[...lines.matchAll(/`+/g)].map((m) => m[0].length + 1)),
    );
    const start = context.map[name.start],
      end = context.map[name.end - 1];
    if (start === undefined || end === undefined) return null;
    return {
      contents: {
        kind: "markdown",
        value: `**PostgreSQL function**\n\n${fence}sql\n${lines}\n${fence}`,
      },
      range: { start: position(source, start), end: position(source, end + 1) },
    };
  }
  signatureHelp(source: string, file: string, at: Position, catalog: Catalog) {
    const context = this.contexts(source, file, at)[0];
    if (!context) return null;
    const tokens = lex(context.sql).filter((t) => t.kind !== "hidden" && t.start < context.at);
    const opens: number[] = [];
    tokens.forEach((t, i) => {
      if (t.text === "(") opens.push(i);
      else if (t.text === ")") opens.pop();
    });
    for (const open of opens.reverse()) {
      const name = tokens[open - 1];
      if (name?.kind !== "id") continue;
      const schema = tokens[open - 2]?.text === "." ? tokens[open - 3]?.name : undefined;
      const functions = (catalog.functions ?? []).filter(
        (f) => f.name === name.name && (schema ? f.schema === schema : f.visible),
      );
      if (!functions.length) continue;
      const parameter = tokens
        .slice(open + 1)
        .filter((t) => t.text === "," && t.depth === tokens[open]!.depth + 1).length;
      const selected = functions.slice(0, 30);
      return {
        signatures: selected.map((f) => {
          const head = `${f.schema}.${f.name}(`;
          let at = head.length;
          return {
            label: `${head}${f.inputTypes.join(", ")}) → ${f.result}`,
            documentation: `Declared signature: ${f.name}(${f.arguments})`,
            parameters: f.inputTypes.map((type) => {
              const label: [number, number] = [at, at + type.length];
              at += type.length + 2;
              return { label };
            }),
          };
        }),
        activeSignature: Math.max(
          0,
          selected.findIndex((f) => f.inputTypes.length > parameter),
        ),
        activeParameter: parameter,
      };
    }
    return null;
  }
  complete(source: string, file: string, at: Position, catalog: Catalog): CompletionList {
    const contexts = this.contexts(source, file, at);
    const cursor = offset(source, at);
    const items = new Map<string, { item: CompletionItem; count: number; details: Set<string> }>();
    for (const context of contexts) {
      const seen = new Set<string>();
      for (const item of candidates(context, source, cursor, catalog)) {
        const key = JSON.stringify([item.label, item.textEdit]);
        if (seen.has(key)) {
          items.get(key)?.details.add(item.detail);
          continue;
        }
        seen.add(key);
        const previous = items.get(key);
        if (previous) {
          previous.count++;
          previous.details.add(item.detail);
        } else items.set(key, { item, count: 1, details: new Set([item.detail]) });
      }
    }
    return {
      isIncomplete: items.size > 200,
      items: [...items.values()].slice(0, 200).map(({ item, count, details }) => ({
        ...item,
        detail: `${[...details].join(" | ")}${count < contexts.length ? ` · available in ${count}/${contexts.length} SQL alternatives` : ""}`,
      })),
    };
  }
}

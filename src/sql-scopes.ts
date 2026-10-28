import { canonical, resolveFunctions } from "./function-types.ts";
import { lex, keyword, type Token } from "./sql-lex.ts";
import type { Catalog, Column, Relation, SqlFunction } from "./catalog.ts";

export interface Binding {
  alias: string;
  relation: Relation;
  sourceAt?: number;
}
export interface Scope {
  start: number;
  end: number;
  depth: number;
  statement: string;
  ctes: Map<string, Relation>;
  bindings: Binding[];
  outer: Binding[];
  target?: Binding;
  targetColumns?: [number, number];
  outputs: Column[];
  indices: number[];
  outputOnly?: boolean;
}
const stops = new Set(
  "as where group order having limit offset fetch window union intersect except returning on using join left right inner outer full cross natural set values select for into from update delete insert conflict do default overriding with ordinality merge matched by source target end then else when and or is null true false".split(
    " ",
  ),
);
const commands = ["select", "update", "insert", "delete", "values", "merge"];
const unknown = (name: string): Column => ({ name, type: "SQL expression", nullable: null });
const relation = (name: string, columns: Column[], origin: string): Relation => ({
  schema: "",
  name,
  visible: true,
  columns,
  origin,
});

/** A bounded, tolerant scope model for completion; PostgreSQL/Reylo still validate SQL. */
export class SqlScopes {
  readonly tokens: Token[];
  readonly scopes: Scope[] = [];
  private pairs = new Map<number, number>();
  private parsed = new Map<string, Scope>();
  constructor(
    readonly sql: string,
    readonly catalog: Catalog,
  ) {
    this.tokens = lex(sql).filter((t) => t.kind !== "hidden");
    const stack: number[] = [];
    this.tokens.forEach((t, i) => {
      if (t.text === "(") stack.push(i);
      if (t.text === ")") {
        const start = stack.pop();
        if (start !== undefined) this.pairs.set(start, i);
      }
    });
    this.parse(0, this.tokens.length, new Map(), [], 0);
  }
  private endParen(i: number, end: number) {
    return this.pairs.get(i) ?? end;
  }
  private local(start: number, end: number, depth: number) {
    const out: number[] = [];
    for (let i = start; i < end; i++) if (this.tokens[i]!.depth === depth) out.push(i);
    return out;
  }
  private rename(columns: Column[], names: string[]) {
    return columns.length
      ? columns.map((c, i) => ({ ...c, name: names[i] ?? c.name }))
      : names.map(unknown);
  }
  private names(start: number, end: number) {
    return this.local(start, end, this.tokens[start]?.depth ?? 0)
      .map((i) => this.tokens[i]!)
      .filter((t) => t.kind === "id")
      .map((t) => t.name);
  }
  private parse(
    start: number,
    end: number,
    inherited: Map<string, Relation>,
    outer: Binding[],
    level: number,
  ): Scope | undefined {
    if (start >= end || level > 24 || this.scopes.length >= 256) return;
    const key = `${start}:${end}`;
    if (this.parsed.has(key)) return this.parsed.get(key);
    const first = this.tokens[start]!;
    const scope: Scope = {
      start: first.start,
      end: this.tokens[end]?.start ?? this.sql.length,
      depth: first.depth,
      statement: "",
      ctes: new Map(inherited),
      bindings: [],
      outer,
      outputs: [],
      indices: [],
    };
    this.parsed.set(key, scope);
    this.scopes.push(scope);
    let begin = start;
    if (keyword(this.tokens[begin], "with")) {
      begin++;
      const recursive = keyword(this.tokens[begin], "recursive");
      if (recursive) begin++;
      while (this.tokens[begin]?.kind === "id") {
        const name = this.tokens[begin++]!.name;
        let names: string[] = [];
        if (this.tokens[begin]?.text === "(") {
          const close = this.endParen(begin, end);
          names = this.names(begin + 1, close);
          begin = close + 1;
        }
        if (!keyword(this.tokens[begin], "as")) break;
        begin++;
        if (keyword(this.tokens[begin], "not")) begin++;
        if (keyword(this.tokens[begin], "materialized")) begin++;
        if (this.tokens[begin]?.text !== "(") break;
        const close = this.endParen(begin, end);
        const declared = relation(name, names.map(unknown), "CTE");
        const env = new Map(scope.ctes);
        if (recursive) env.set(name, declared);
        const body = this.parse(begin + 1, close, env, [], level + 1);
        declared.columns = this.rename(body?.outputs ?? [], names);
        scope.ctes.set(name, declared);
        begin = close + 1;
        if (this.tokens[begin]?.text !== ",") break;
        begin++;
      }
    }
    scope.statement = commands.find((c) => keyword(this.tokens[begin], c)) ?? "";
    let armEnd = end;
    const set = this.local(begin, end, scope.depth).find((i) =>
      ["union", "intersect", "except"].some((k) => keyword(this.tokens[i], k)),
    );
    if (set !== undefined) {
      armEnd = set;
      scope.end = this.tokens[set]!.start;
    }
    scope.indices = this.local(begin, armEnd, scope.depth);
    const t = this.tokens;
    let targetEnd = begin;
    if (["insert", "update", "delete", "merge"].includes(scope.statement)) {
      let i = begin + 1;
      if (keyword(t[i], "into") || keyword(t[i], "from")) i++;
      const read = this.readSource(i, armEnd, scope, level, true);
      if (read) {
        scope.target = read.binding;
        scope.bindings.push(read.binding);
        targetEnd = read.next;
      }
      if (scope.statement === "insert" && t[targetEnd]?.text === "(") {
        const close = this.endParen(targetEnd, armEnd);
        scope.targetColumns = [t[targetEnd]!.end, t[close]?.start ?? this.sql.length];
        targetEnd = close + 1;
      }
    }
    let from = false;
    for (let p = 0; p < scope.indices.length; p++) {
      const i = scope.indices[p]!;
      if (i < targetEnd) continue;
      const token = t[i]!;
      if (scope.statement === "insert") continue;
      if (
        keyword(token, "from") ||
        (["delete", "merge"].includes(scope.statement) && keyword(token, "using"))
      )
        from = true;
      else if (
        ["where", "group", "order", "having", "limit", "returning", "set"].some((k) =>
          keyword(token, k),
        )
      )
        from = false;
      const trigger =
        keyword(token, "from") ||
        keyword(token, "join") ||
        (["delete", "merge"].includes(scope.statement) && keyword(token, "using")) ||
        (from && token.text === ",");
      if (!trigger) continue;
      // DELETE's initial FROM is already the target relation.
      if (scope.statement === "delete" && i < targetEnd) continue;
      const read = this.readSource(i + 1, armEnd, scope, level, false);
      if (read) {
        scope.bindings.push(read.binding);
        while (scope.indices[p + 1] !== undefined && scope.indices[p + 1]! < read.next) p++;
      }
    }
    if (scope.statement === "select") {
      let i = begin + 1;
      if (keyword(t[i], "all")) i++;
      if (keyword(t[i], "distinct")) {
        i++;
        if (keyword(t[i], "on") && t[i + 1]?.text === "(") i = this.endParen(i + 1, armEnd) + 1;
      }
      const endList =
        scope.indices.find(
          (j) =>
            j > i &&
            ["from", "where", "group", "order", "having", "limit", "window", "into"].some((k) =>
              keyword(t[j], k),
            ),
        ) ?? armEnd;
      scope.outputs = this.project(i, endList, scope);
    } else if (scope.statement === "values") {
      const open = begin + 1;
      if (t[open]?.text === "(")
        scope.outputs = this.split(open + 1, this.endParen(open, armEnd), scope.depth + 1).map(
          (part, i) => ({
            name: `column${i + 1}`,
            type: this.expressionType(part, scope),
            nullable: null,
          }),
        );
    } else {
      const returning = scope.indices.find((i) => keyword(t[i], "returning"));
      if (returning !== undefined) scope.outputs = this.project(returning + 1, armEnd, scope);
    }
    // Scalar subqueries can correlate; non-LATERAL FROM subqueries were parsed
    // above with no outer bindings and are reused here, preserving the boundary.
    for (let i = begin; i < armEnd; i++) {
      if (t[i]?.text !== "(") continue;
      const close = this.endParen(i, armEnd);
      if (["with", ...commands].some((k) => keyword(t[i + 1], k)))
        this.parse(i + 1, close, scope.ctes, this.visible(scope), level + 1);
      if (close < armEnd && ["with", ...commands].some((k) => keyword(t[i + 1], k))) i = close;
    }
    if (scope.statement === "insert") {
      const select = scope.indices.find((i) => i >= targetEnd && keyword(t[i], "select"));
      if (select !== undefined) {
        const stop =
          scope.indices.find(
            (i) =>
              i > select &&
              (keyword(t[i], "returning") ||
                (keyword(t[i], "on") && keyword(t[i + 1], "conflict"))),
          ) ?? armEnd;
        this.parse(select, stop, scope.ctes, [], level + 1);
      }
    }
    if (set !== undefined) {
      let next = set + 1;
      if (keyword(t[next], "all") || keyword(t[next], "distinct")) next++;
      const arm = this.parse(next, end, scope.ctes, outer, level + 1);
      scope.outputs = scope.outputs.map((c, i) => ({
        ...c,
        type: arm?.outputs[i]?.type === c.type ? c.type : "SQL expression",
      }));
      const ordering = this.local(next, end, scope.depth).find((i) => keyword(t[i], "order"));
      if (ordering !== undefined) {
        const at = t[ordering]!.start;
        const prior = this.scopes.findIndex((s) => s.outputOnly && s.start === at);
        if (prior >= 0) this.scopes.splice(prior, 1);
        this.scopes.push({
          ...scope,
          start: at,
          end: t[end]?.start ?? this.sql.length,
          statement: "select",
          outputOnly: true,
          outer: [],
          bindings: [{ alias: "", relation: relation("set result", scope.outputs, "set result") }],
          indices: this.local(ordering, end, scope.depth),
        });
      }
    }
    return scope;
  }
  private readSource(
    start: number,
    end: number,
    scope: Scope,
    level: number,
    target: boolean,
  ): { binding: Binding; next: number } | undefined {
    const t = this.tokens;
    let i = start;
    const lateral = keyword(t[i], "lateral");
    if (lateral || keyword(t[i], "only")) i++;
    let source: Relation;
    let defaultAlias = "";
    let scalarFunction = false;
    if (t[i]?.text === "(" && !target) {
      const close = this.endParen(i, end);
      const child = this.parse(
        i + 1,
        close,
        scope.ctes,
        lateral ? this.visible(scope) : [],
        level + 1,
      );
      source = relation("subquery", child?.outputs ?? [], "subquery");
      i = close + 1;
    } else {
      if (t[i]?.kind !== "id") return;
      let name = t[i++]!.name;
      let schema: string | undefined;
      if (t[i]?.text === "." && t[i + 1]?.kind === "id") {
        schema = name;
        name = t[i + 1]!.name;
        i += 2;
      }
      defaultAlias = name;
      if (t[i]?.text === "(" && !target) {
        const close = this.endParen(i, end);
        const overloads = this.functions(name, schema);
        const args = this.split(i + 1, close, scope.depth + 1).map((part) =>
          this.expressionType(part, scope),
        );
        const options = resolveFunctions(overloads, args, this.catalog);
        scalarFunction =
          options.length > 0 &&
          options.every((f) => !f.columns.length && !/^(SETOF )?(record|any\w*)$/.test(f.result));
        const shapes = options.map((f) =>
          f.columns.length
            ? f.columns
            : /^(SETOF )?(record|any\w*)$/.test(f.result)
              ? []
              : [{ name, type: f.result.replace(/^SETOF /, ""), nullable: null }],
        );
        const common =
          shapes[0]?.filter((c) => shapes.every((s) => s.some((v) => v.name === c.name))) ?? [];
        source = relation(
          name,
          common.map((c) => ({
            ...c,
            type: shapes.every((s) => s.find((v) => v.name === c.name)?.type === c.type)
              ? c.type
              : "SQL expression",
            nullable: null,
          })),
          "function output",
        );
        i = close + 1;
        if (keyword(t[i], "with") && keyword(t[i + 1], "ordinality")) {
          source.columns.push({ name: "ordinality", type: "bigint", nullable: null });
          i += 2;
        }
      } else
        source =
          (!schema && !target ? scope.ctes.get(name) : undefined) ??
          this.catalog.relations.find(
            (r) => r.name === name && (schema ? r.schema === schema : r.visible),
          ) ??
          relation(name, [], "unresolved relation");
    }
    if (keyword(t[i], "as")) i++;
    const alias = t[i];
    const hasAlias = alias?.kind === "id" && (alias.text.startsWith('"') || !stops.has(alias.name));
    const binding: Binding = {
      alias: hasAlias ? alias.name : defaultAlias,
      relation: source,
      sourceAt: t[start]?.start,
    };
    if (hasAlias) {
      i++;
      if (scalarFunction)
        binding.relation = {
          ...source,
          columns: source.columns.map((c, j) => (j === 0 ? { ...c, name: alias.name } : c)),
        };
    }
    if (!target && t[i]?.text === "(") {
      const close = this.endParen(i, end);
      const definitions = this.split(i + 1, close, scope.depth + 1);
      const names = definitions.map((p) => t[p[0] ?? -1]?.name).filter((n): n is string => !!n);
      const typed = definitions.every((p) => p.length > 1 && t[p[0]!]!.kind === "id");
      binding.relation = {
        ...source,
        columns: typed
          ? definitions.map((p) => ({
              name: t[p[0]!]!.name,
              type: canonical(
                p
                  .slice(1)
                  .map((i) => t[i]!.text)
                  .join(" "),
              ),
              nullable: null,
            }))
          : this.rename(binding.relation.columns, names),
      };
      i = close + 1;
    }
    return { binding, next: i };
  }
  private split(start: number, end: number, depth: number): number[][] {
    const out: number[][] = [];
    let part: number[] = [];
    for (let i = start; i < end; i++) {
      if (this.tokens[i]!.text === "," && this.tokens[i]!.depth === depth) {
        out.push(part);
        part = [];
      } else part.push(i);
    }
    if (part.length) out.push(part);
    return out;
  }
  private project(start: number, end: number, scope: Scope): Column[] {
    const out: Column[] = [];
    const t = this.tokens;
    for (const original of this.split(start, end, scope.depth)) {
      let part = [...original];
      const last = t[part.at(-1) ?? -1];
      if (!last) continue;
      if (
        (part.length === 1 && last.text === "*") ||
        (part.length === 3 && t[part[1]!]!.text === "." && last.text === "*")
      ) {
        const bindings =
          part.length === 1
            ? scope.bindings
            : this.visible(scope).filter((b) => b.alias === t[part[0]!]!.name);
        out.push(
          ...bindings.flatMap((b) => b.relation.columns).map((c) => ({ ...c, nullable: null })),
        );
        continue;
      }
      let name: string | undefined;
      if (last.kind === "id" && keyword(t[part.at(-2) ?? -1], "as")) {
        name = last.name;
        part = part.slice(0, -2);
      } else if (
        last.kind === "id" &&
        part.length > 1 &&
        t[part.at(-2)!]!.end < last.start &&
        (t[part.at(-2)!]!.kind === "id" ||
          t[part.at(-2)!]!.text === ")" ||
          /^\d$/.test(t[part.at(-2)!]!.text)) &&
        !stops.has(last.name)
      ) {
        name = last.name;
        part = part.slice(0, -1);
      }
      if (!name) {
        if (part.length === 1 && last.kind === "id") name = last.name;
        else if (part.length === 3 && t[part[1]!]!.text === "." && last.kind === "id")
          name = last.name;
        else if (t[part[0]!]!.kind === "id" && t[part[1] ?? -1]?.text === "(")
          name = t[part[0]!]!.name;
      }
      if (!name) {
        const cast = part.findIndex(
          (i, p) => t[i]!.text === ":" && t[part[p + 1] ?? -1]?.text === ":",
        );
        if (cast === 1 && t[part[0]!]!.kind === "id") name = t[part[0]!]!.name;
        if (cast === 3 && t[part[1]!]!.text === ".") name = t[part[2]!]!.name;
        if (part.length > 3 && t[part[1]!]!.text === "." && t[part[3]!]!.text === "(")
          name = t[part[2]!]!.name;
      }
      if (name) out.push({ name, type: this.expressionType(part, scope), nullable: null });
    }
    return out;
  }
  private expressionType(part: number[], scope: Scope, level = 0): string {
    if (level > 24) return "SQL expression";
    const t = this.tokens;
    const first = t[part[0] ?? -1];
    if (!first) return "SQL expression";
    const col =
      part.length === 1
        ? first.name
        : part.length === 3 && t[part[1]!]!.text === "."
          ? t[part[2]!]!.name
          : undefined;
    if (col) {
      const columns = this.visible(scope)
        .filter((b) => part.length === 1 || b.alias === first.name)
        .flatMap((b) => b.relation.columns.filter((c) => c.name === col));
      if (columns.length === 1) return columns[0]!.type;
    }
    const text = part.map((i) => t[i]!.text).join("");
    if (/^-?\d+$/.test(text)) return "integer";
    const cast = part.findLastIndex(
      (i, p) =>
        t[i]!.depth === first.depth && t[i]!.text === ":" && t[part[p + 1] ?? -1]?.text === ":",
    );
    if (cast >= 0) {
      const type = part
        .slice(cast + 2)
        .map((i) => t[i]!.text)
        .join(" ");
      return canonical(type);
    }
    let open = part[1];
    let schema: string | undefined;
    let name = first.name;
    if (t[part[1] ?? -1]?.text === ".") {
      schema = name;
      name = t[part[2] ?? -1]?.name ?? "";
      open = part[3];
    }
    if (open !== undefined && t[open]?.text === "(") {
      const close = this.endParen(open, part.at(-1)! + 1);
      const args = this.split(open + 1, close, t[open]!.depth + 1)
        .filter((p) => !(p.length === 1 && t[p[0]!]!.text === "*"))
        .map((p) => this.expressionType(p, scope, level + 1));
      const options = this.functions(name, schema);
      const results = new Set(resolveFunctions(options, args, this.catalog).map((f) => f.result));
      if (results.size === 1) return [...results][0]!.replace(/^SETOF /, "");
    }
    return "SQL expression";
  }
  functions(name: string, schema?: string): SqlFunction[] {
    return (this.catalog.functions ?? []).filter(
      (f) => f.name === name && (schema ? f.schema === schema : f.visible),
    );
  }
  visible(scope: Scope): Binding[] {
    const aliases = new Set(scope.bindings.map((b) => b.alias));
    return [...scope.bindings, ...scope.outer.filter((b) => !aliases.has(b.alias))];
  }
  at(at: number): Scope | undefined {
    return this.scopes
      .filter((s) => at >= s.start && at <= s.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  }
  mode(
    scope: Scope,
    at: number,
    previous: Token | undefined,
  ): "relation" | "target" | "expression" | "value" | "none" {
    const t = this.tokens;
    if (scope.statement === "merge") {
      const branch = this.mergeBranch(scope, at);
      if (branch) {
        const insert = branch.find((i) => keyword(t[i], "insert"));
        if (insert !== undefined && t[insert + 1]?.text === "(") {
          const close = this.endParen(insert + 1, this.tokens.length);
          if (at >= t[insert + 1]!.end && at <= (t[close]?.start ?? this.sql.length))
            return "target";
        }
      }
    }
    const before = scope.indices.filter((i) => t[i]!.end <= at);
    if (scope.targetColumns && at >= scope.targetColumns[0] && at <= scope.targetColumns[1])
      return "target";
    const lastClause = before
      .filter((i) =>
        [
          "from",
          "join",
          "where",
          "select",
          "group",
          "order",
          "on",
          "using",
          "returning",
          "set",
          "values",
        ].some((k) => keyword(t[i], k)),
      )
      .at(-1);
    const conflict = before.find((i) => keyword(t[i], "conflict"));
    if (scope.statement === "insert" && conflict !== undefined && t[conflict + 1]?.text === "(") {
      const close = this.endParen(conflict + 1, this.tokens.length);
      if (at >= t[conflict + 1]!.end && at <= (t[close]?.start ?? this.sql.length)) return "target";
    }
    if (
      ["from", "join", "into", "only", "lateral"].some((k) => keyword(previous, k)) ||
      (keyword(previous, "update") && scope.statement === "update") ||
      (keyword(previous, "using") && ["delete", "merge"].includes(scope.statement)) ||
      (previous?.text === "," && ["from", "using"].some((k) => keyword(t[lastClause ?? -1], k)))
    )
      return "relation";
    if (
      keyword(t[lastClause ?? -1], "set") &&
      !(scope.statement === "merge" && before.some((i) => i > lastClause! && keyword(t[i], "when")))
    ) {
      const segment = before.filter((i) => i > lastClause!);
      const comma = segment.findLastIndex((i) => t[i]!.text === ",");
      if (!segment.slice(comma + 1).some((i) => t[i]!.text === "=")) return "target";
    }
    if (
      scope.statement === "insert" &&
      lastClause !== undefined &&
      keyword(t[lastClause], "values")
    )
      return "value";
    return scope.statement ? "expression" : "none";
  }
  private mergeBranch(scope: Scope, at: number): number[] | undefined {
    const before = scope.indices.filter((i) => this.tokens[i]!.start < at);
    const last = before.findLastIndex(
      (i) => keyword(this.tokens[i], "when") || keyword(this.tokens[i], "returning"),
    );
    return last >= 0 && keyword(this.tokens[before[last]!], "when")
      ? before.slice(last)
      : undefined;
  }
  bindingsAt(scope: Scope, at: number): Binding[] {
    let bindings = this.visible(scope);
    if (scope.statement === "merge") {
      const branch = this.mergeBranch(scope, at);
      if (branch?.some((i) => keyword(this.tokens[i], "not"))) {
        const sourceOnly = !branch.some(
          (i, j) =>
            keyword(this.tokens[i], "source") && keyword(this.tokens[branch[j - 1] ?? -1], "by"),
        );
        bindings = bindings.filter((b) => (sourceOnly ? b !== scope.target : b === scope.target));
      }
    }
    // JOIN ON cannot refer to relations introduced by a later JOIN.
    const clauses = scope.indices.filter(
      (i) =>
        this.tokens[i]!.start < at &&
        ["on", "where", "select", "returning", "order", "having", "group"].some((k) =>
          keyword(this.tokens[i], k),
        ),
    );
    if (scope.statement !== "merge" && keyword(this.tokens[clauses.at(-1) ?? -1], "on"))
      bindings = bindings.filter((b) => b.sourceAt === undefined || b.sourceAt < at);
    if (scope.statement !== "insert" || !scope.target) return bindings;
    const before = scope.indices
      .filter((i) => this.tokens[i]!.start < at)
      .map((i) => this.tokens[i]!);
    const conflict = before.findIndex((t) => keyword(t, "conflict"));
    if (
      conflict >= 0 &&
      before.slice(conflict).some((t, i, a) => keyword(t, "do") && keyword(a[i + 1], "update")) &&
      !before.some((t) => keyword(t, "returning"))
    ) {
      if (!bindings.some((b) => b.alias === "excluded"))
        bindings.push({
          alias: "excluded",
          relation: { ...scope.target.relation, origin: "EXCLUDED row" },
        });
    }
    return bindings;
  }
}

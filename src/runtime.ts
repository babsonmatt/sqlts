import { checks, defineQuery, type PostgresClient, type QueryDefinition } from "reylo";
import type { QueryResult, PostgresQueryError } from "./postgres-errors.ts";
import { observeQuery } from "./query-events.ts";
import { captureExecution } from "./execution-metadata.ts";
export { subscribeQueries, type QueryEvent } from "./query-events.ts";
export type { QueryResult, PostgresQueryError } from "./postgres-errors.ts";
import { group, render, type Clause, type Parts, type Part } from "./parts.ts";

declare const parameters: unique symbol;
export interface Fragment<P extends readonly unknown[] = readonly unknown[]> {
  readonly [parameters]: P;
}
type FlatValue<V> = V extends Fragment<infer P> ? P : readonly [V];
type Flat<V extends readonly unknown[]> = V extends readonly [infer H, ...infer T]
  ? readonly [...FlatValue<H>, ...Flat<T>]
  : readonly [];
// Falsy helper arguments omit predicates; interpolated SQL values are never omitted.
type Operand = Fragment | undefined | null | false | "" | 0 | 0n;
type Present<V> = V extends Fragment<infer P> ? P : readonly [];
type FlatOperands<V extends readonly Operand[]> = V extends readonly [
  infer H,
  ...infer T extends readonly Operand[],
]
  ? readonly [...Present<H>, ...FlatOperands<T>]
  : readonly [];
export type Registry = Record<string, { inputs: readonly unknown[]; row: unknown }>;
export type Cardinality = "many" | "one" | "maybeOne" | "none";
export type Materialize<Row, C extends Cardinality> = C extends "many"
  ? Row[]
  : C extends "one"
    ? Row
    : C extends "none"
      ? void
      : Row | null;
export type AnalyzedQuery = QueryDefinition & { inferredCardinality?: Cardinality };
export type Artifact = Record<string, Record<string, AnalyzedQuery>>;
export interface RunResult<Row> {
  rows: Row[];
  /** Top-level rows written; null when the driver does not expose a reliable count. */
  affectedRows: number | null;
  /** Native command tag, or null when the driver does not expose it. */
  command: string | null;
}
export interface Query<Row, C extends Cardinality = Cardinality, E = PostgresQueryError> {
  readonly sql: string;
  readonly raw: string;
  readonly source: string | undefined;
  readonly cardinality: C;
  /** Schemas describe positional bindings (p0, p1, ...) and the run() result as JSON. */
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "sqlts";
    readonly types?: { input: Record<string, unknown>; output: Row[] };
    readonly jsonSchema: {
      input(options?: {
        target: string;
        libraryOptions?: Record<string, unknown>;
      }): Record<string, unknown>;
      output(options?: {
        target: string;
        libraryOptions?: Record<string, unknown>;
      }): Record<string, unknown>;
    };
  };
  /** SQL after engine rewrites, plus snapshotted values before driver encoding. */
  compile(): { text: string; values: unknown[] };
  /** Backwards compatible: always an array. */
  run(db: PostgresClient): Promise<Row[]>;
  /** The same typed rows plus native write counts, without another SQL statement. */
  runWithMetadata(db: PostgresClient): Promise<RunResult<Row>>;
  /** Use the analyzer's result cardinality: rows, a row, row|null, or void. */
  execute(db: PostgresClient): Promise<Materialize<Row, C>>;
  /** Enforce exactly one returned row; never silently discard extra rows. */
  one(db: PostgresClient): Promise<Row>;
  /** Enforce at most one returned row. */
  maybeOne(db: PostgresClient): Promise<Row | null>;
  try(db: PostgresClient): Promise<QueryResult<Row[], E>>;
  /** Bind this query's already-snapshotted parameters to a client/transaction. */
  with(db: PostgresClient): () => Promise<Row[]>;
}
export class CardinalityError extends Error {
  readonly expected: "one" | "maybeOne" | "none";
  readonly actual: number;
  constructor(expected: "one" | "maybeOne" | "none", actual: number) {
    super(
      `Expected ${expected === "one" ? "exactly one row" : expected === "none" ? "no rows" : "at most one row"}, received ${actual}`,
    );
    this.name = "CardinalityError";
    this.expected = expected;
    this.actual = actual;
  }
}
export type QueryTag<
  Inputs extends readonly unknown[],
  Row,
  C extends Cardinality = Cardinality,
  E = PostgresQueryError,
> = <const V extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...values: V & (Flat<V> extends Inputs ? unknown : { readonly invalidSqlParameters: Inputs })
) => Query<Row, C, E>;
export interface Sql<R extends Registry> {
  <const V extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: V
  ): Fragment<Flat<V>>;
  readonly empty: Fragment<readonly []>;
  /** Join present predicates with AND and emit WHERE; falsy arguments are omitted. */
  where<const V extends readonly Operand[]>(...values: V): Fragment<FlatOperands<V>>;
  /** Group present predicates with AND; no predicates yields TRUE. Accepts condition && fragment. */
  and<const V extends readonly Operand[]>(...values: V): Fragment<FlatOperands<V>>;
  /** Group present predicates with OR; no predicates yields FALSE. Accepts condition && fragment. */
  or<const V extends readonly Operand[]>(...values: V): Fragment<FlatOperands<V>>;
  query<K extends keyof R & string>(id: K): QueryTag<R[K]["inputs"], R[K]["row"]>;
}

// Module-scoped identity permits checked fragments to cross SQLTS module boundaries.
const sharedFragments = new WeakMap<object, Parts>();
export function createSql<R extends Registry>(artifact: Artifact, shareFragments = false): Sql<R> {
  const fragments = shareFragments ? sharedFragments : new WeakMap<object, Parts>();
  const makeExecutable = (metadata: QueryDefinition, compiled: ReturnType<typeof render>) =>
    defineQuery<Record<string, unknown>, unknown, "many", "postgres">({
      ...metadata,
      dialect: "postgres",
      cardinality: "many",
      sql: metadata.sql,
      text: metadata.text ?? compiled.text,
      order: metadata.order ?? compiled.values.map((_, i) => `p${i}`),
      checks,
    });
  // Only validated artifact shapes enter this instance-local cache. Keep request
  // values and clients out of it; stable executable identity preserves Reylo's
  // own freshness interval without changing or bypassing its schema checks.
  const executables = new Map<
    string,
    Map<
      string,
      {
        metadata: QueryDefinition;
        executable: ReturnType<typeof makeExecutable>;
      }
    >
  >();
  const fragment = (parts: Parts): Fragment => {
    const f = Object.freeze({}) as Fragment;
    fragments.set(f, parts);
    return f;
  };
  const get = (v: unknown): Parts | undefined =>
    typeof v === "object" && v !== null ? fragments.get(v) : undefined;
  const template = (strings: TemplateStringsArray, values: readonly unknown[]): Parts => {
    // Only real tagged templates; interpolated strings are always bound values.
    if (!Object.isFrozen(strings) || !Object.isFrozen(strings.raw))
      throw new Error("Use a SQL tagged template");
    const parts: Part[] = [];
    strings.forEach((text, i) => {
      parts.push(text);
      if (i < values.length)
        parts.push(...(get(values[i]) ?? [{ value: structuredClone(values[i]) }]));
    });
    return parts;
  };
  const clause = (kind: Clause, values: readonly Operand[]) =>
    fragment(
      group(
        kind,
        values.map((v) => {
          if (!v) return [];
          const parts = get(v);
          if (!parts) throw new Error("SQL clauses accept fragments from this sql instance only");
          return parts;
        }),
      ),
    );
  const tag = (strings: TemplateStringsArray, ...values: readonly unknown[]) =>
    fragment(template(strings, values));
  return Object.freeze(
    Object.assign(tag, {
      empty: fragment([]),
      where: (...values: Operand[]) => clause("where", values),
      and: (...values: Operand[]) => clause("and", values),
      or: (...values: Operand[]) => clause("or", values),
      query:
        (id: string) =>
        (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
          const compiled = render(template(strings, values));
          const metadata =
            Object.hasOwn(artifact, id) && Object.hasOwn(artifact[id]!, compiled.named)
              ? artifact[id]![compiled.named]
              : undefined;
          if (!metadata)
            throw new Error(
              `Unknown or stale SQL shape for '${id}'; recheck and reload the query module`,
            );
          const params = Object.fromEntries(compiled.values.map((v, i) => [`p${i}`, v]));
          let shapes = executables.get(id);
          if (!shapes) {
            shapes = new Map();
            executables.set(id, shapes);
          }
          let cached = shapes.get(compiled.named);
          if (!cached || cached.metadata !== metadata) {
            cached = { metadata, executable: makeExecutable(metadata, compiled) };
            shapes.set(compiled.named, cached);
          }
          const executable = cached.executable;
          const text = metadata.text ?? compiled.text;
          const order = metadata.order ?? compiled.values.map((_, i) => `p${i}`);
          const cardinality = metadata.inferredCardinality ?? "many";
          const schema = (kind: "input" | "output", options?: { target: string }) => {
            if (options && options.target !== "draft-2020-12")
              throw new Error(
                `Unsupported JSON Schema target: ${options.target}; SQLTS exports draft-2020-12`,
              );
            const value = metadata.jsonSchema?.[kind];
            if (!value) throw new Error("No JSON Schema metadata is available for this query");
            return structuredClone(value);
          };
          const run = (db: PostgresClient) =>
            observeQuery({ sql: text, source: metadata.source, cardinality }, () =>
              executable.run(db, structuredClone(params)),
            );
          const single = async (db: PostgresClient, required: boolean) => {
            const rows = await run(db);
            if (rows.length > 1 || (required && rows.length !== 1))
              throw new CardinalityError(required ? "one" : "maybeOne", rows.length);
            return rows[0] ?? null;
          };
          return Object.freeze({
            sql: text,
            raw: compiled.named,
            source: metadata.source,
            cardinality,
            get inputSchema() {
              return schema("input");
            },
            get outputSchema() {
              return schema("output");
            },
            "~standard": Object.freeze({
              version: 1 as const,
              vendor: "sqlts" as const,
              jsonSchema: Object.freeze({
                input: (options?: { target: string }) => schema("input", options),
                output: (options?: { target: string }) => schema("output", options),
              }),
            }),
            compile: () => ({ text, values: structuredClone(order.map((n) => params[n])) }),
            run,
            runWithMetadata: (db: PostgresClient) =>
              captureExecution(db, metadata.fresh?.query, run),
            one: (db: PostgresClient) => single(db, true),
            maybeOne: (db: PostgresClient) => single(db, false),
            execute: async (db: PostgresClient) => {
              if (cardinality === "one") return single(db, true);
              if (cardinality === "maybeOne") return single(db, false);
              const rows = await run(db);
              if (cardinality === "none") {
                if (rows.length) throw new CardinalityError("none", rows.length);
                return;
              }
              return rows;
            },
            try: async (db: PostgresClient) => {
              let databaseError: PostgresQueryError | undefined;
              try {
                const value = await observeQuery(
                  { sql: text, source: metadata.source, cardinality },
                  async () => {
                    const result = await executable.try(db, structuredClone(params));
                    if (result.error) {
                      databaseError = result.error;
                      throw result.error;
                    }
                    return result.value;
                  },
                );
                return { value };
              } catch (cause) {
                if (databaseError && cause === databaseError) return { error: databaseError };
                throw cause;
              }
            },
            with: (db: PostgresClient) => () => run(db),
          });
        },
    }),
  ) as Sql<R>;
}

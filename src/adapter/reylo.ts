// Version-pinned adapter: tooling, cache entries, and value metadata are Reylo internals.
// Keep all compatibility assumptions here; do not pretend these are a stable public API.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { QueryDefinition } from "reylo";
import type { AnalyzedQuery } from "../runtime.ts";
import { tokens } from "./lex.ts";
import { bind } from "./bind.ts";

export interface Diagnostic {
  messageText: string;
  start: number;
  length: number;
  code: number;
}
export interface Transform {
  text: string;
  diagnostics: Diagnostic[];
  extension: string;
  mappings: number[][];
}
export interface TransformParams {
  projectHandle: string;
  fileName: string;
  content: string;
}
export interface OpenParams {
  projectHandle: string;
  configFileName: string;
  options?: Record<string, unknown>;
}
export interface Handlers {
  initialize(p: { protocolVersion?: number }): object;
  openProject(
    p: OpenParams,
  ): Promise<{ configIdentity: string; watchedFiles: string[]; optionDiagnostics: unknown[] }>;
  transform(p: TransformParams): Promise<Transform>;
  closeProject(p: { projectHandle: string }): Promise<object>;
}
interface Tooling {
  mapperHandlers(): Handlers;
  sqlModule(path: string, sql: string): Promise<{ code: string; entry: string; watched: string[] }>;
  releaseConnections(): Promise<void>;
}
type Input = NonNullable<QueryDefinition["inputs"]>[string];
interface Analysis {
  kind: string;
  cardinality?: string;
  params: (Input & { name: string })[];
  columns: { name: string; type: Input["type"]; nullable: boolean }[];
  diagnostics: { message: string }[];
  fresh?: QueryDefinition["fresh"];
}
interface Values {
  columnKind(t: Input["type"], dialect: "postgres"): string;
  arrayDelimiter(t: Input["type"]): string | undefined;
}
const entry = import.meta.resolve("reylo");
const manifest = JSON.parse(await readFile(new URL("../package.json", entry), "utf8")) as {
  version: string;
  sqltsSourceCommit?: string;
};
if (
  manifest.version !== "0.5.0-sqlts.c8a03f9" ||
  manifest.sqltsSourceCommit !== "c8a03f97b870ddea6bb973485bacf4737c82f502"
)
  throw new Error(
    "This SQLTS build requires Reylo 0.5.0-sqlts.c8a03f9; review src/adapter/reylo.ts before upgrading",
  );
const engineManifest = JSON.parse(
  await readFile(new URL(import.meta.resolve("@reylosql/postgres/package.json")), "utf8"),
) as { version: string; sqltsSourceCommit?: string };
if (
  engineManifest.version !== manifest.version ||
  engineManifest.sqltsSourceCommit !== manifest.sqltsSourceCommit
)
  throw new Error("Reylo and @reylosql/postgres must use the same pinned SQLTS source build");
const toolingPath = import.meta.resolve("@reylosql/postgres/tooling");
const nativeTooling = (await import(toolingPath)).default as Tooling;
const projectIdentities = new Map<string, string>();
export const tooling: Tooling = {
  ...nativeTooling,
  mapperHandlers() {
    const handlers = nativeTooling.mapperHandlers();
    return {
      ...handlers,
      async openProject(p) {
        const result = await handlers.openProject(p);
        projectIdentities.set(p.projectHandle, result.configIdentity);
        return result;
      },
      async closeProject(p) {
        projectIdentities.delete(p.projectHandle);
        const prefix = `[${JSON.stringify(p.projectHandle)},`;
        for (const key of typeCache.keys()) if (key.startsWith(prefix)) typeCache.delete(key);
        return handlers.closeProject(p);
      },
    };
  },
};
const values = (await import(new URL("./values.js", entry).href)) as Values;

export function alias(text: string, name: "Params" | "Row" | "QueryError"): string {
  const start = text.indexOf(`export type ${name} = `);
  const end = text.indexOf(
    name === "Params"
      ? ";\nexport type Row"
      : name === "Row"
        ? ";\nexport type QueryError"
        : ";\n/**",
    start,
  );
  if (start < 0 || end < 0) throw new Error("Reylo virtual-module format changed");
  return text.slice(start + `export type ${name} = `.length, end);
}

export async function metadata(path: string, sql: string): Promise<AnalyzedQuery> {
  const result = await tooling.sqlModule(path, sql);
  return metadataFromCache(
    path,
    sql,
    JSON.parse(await readFile(result.entry, "utf8")),
    result.code,
  );
}
interface CachedAnalysis {
  schema: string;
  version: number;
  dialect: string;
  analysis: Analysis;
}
function metadataFromCache(
  path: string,
  sql: string,
  cached: CachedAnalysis,
  code: string,
): AnalyzedQuery {
  /* Reylo is the sole owner of its on-disk cache. */
  if (cached.version !== 1 || cached.dialect !== "postgres")
    throw new Error("Unsupported Reylo analysis format or statement");
  const a = cached.analysis;
  // Read the JSON literal emitted by the pinned native module, never execute it.
  const line = code.split("\n").find((l) => l.startsWith("export default defineQuery("));
  const match = line && /, jsonSchema: (.*?)(?:, checks)? \}\);$/.exec(line);
  if (!match) throw new Error("Unsupported Reylo module schema format");
  const schemas = JSON.parse(match[1]!) as NonNullable<QueryDefinition["jsonSchema"]>;
  // The engine rewrites its extensions (e.g. schema-annotated JSON casts).
  // Preserve the emitted SQL and binding order instead of rebuilding SQL text.
  const compiled = code.split("\n").find((l) => l.startsWith("export const sql = "));
  const order = line && /, order: (\[[^\n]*?\])(?:,| \})/.exec(line);
  if (!compiled || !order) throw new Error("Unsupported Reylo compiled SQL format");
  const text = JSON.parse(compiled.slice("export const sql = ".length).replace(/;$/, "")) as string;
  const bindingOrder = JSON.parse(order[1]!) as string[];
  const inferredCardinality = a.cardinality;
  if (!["one", "maybeOne", "many", "none"].includes(inferredCardinality ?? ""))
    throw new Error("Unsupported Reylo cardinality");
  const output = schemas.output;
  const row =
    a.cardinality === "many"
      ? output.items
      : a.cardinality === "maybeOne"
        ? (output.anyOf as unknown[])?.[0]
        : output;
  schemas.output =
    a.kind === "select" || a.columns.length
      ? { $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", items: row }
      : { type: "array", items: false };
  if (a.diagnostics.length) throw new Error(a.diagnostics.map((d) => d.message).join("\n"));
  return {
    dialect: "postgres",
    jsonSchema: schemas,
    sql,
    text,
    order: bindingOrder,
    inferredCardinality: inferredCardinality as AnalyzedQuery["inferredCardinality"],
    params: a.params.map((p) => p.name),
    cardinality: "many",
    inputs: Object.fromEntries(
      a.params.map((p) => [
        p.name,
        {
          type: p.type,
          nullable: p.nullable,
          ...(p.schema === undefined ? {} : { schema: p.schema }),
          ...(p.cast === undefined ? {} : { cast: p.cast }),
        },
      ]),
    ),
    columns: a.columns.map((c) => {
      const delimiter = values.arrayDelimiter(c.type);
      return delimiter === undefined
        ? [c.name, values.columnKind(c.type, "postgres")]
        : [c.name, values.columnKind(c.type, "postgres"), delimiter];
    }),
    source: path,
    fresh: a.fresh,
  };
}

// A live schema check remains owned by Reylo on every lookup. Cache only the virtual
// type text, keyed by its validated analysis and mapper project (including its settings).
const typeCache = new Map<string, Transform>();
const stats = { validated: 0, transformed: 0, reused: 0 };
export const analysisStats = () => ({ ...stats });
export function resetAnalysisStats() {
  stats.validated = stats.transformed = stats.reused = 0;
}
export async function analyzeQuery(p: TransformParams, handlers: Handlers) {
  // Reylo 0.5 accepts one occurrence per name. Analyze independent occurrences,
  // verify identical input contracts, and expose one caller argument again.
  const seen = new Set<string>();
  const renames = new Map<string, string>();
  const occurrences = tokens(p.content)
    .filter((t) => t.kind === "code")
    .flatMap((t) =>
      [...t.text.matchAll(/(?<!:):([A-Za-z_][A-Za-z_0-9]*)/g)].map((m) => ({
        name: m[1]!,
        start: t.start + m.index,
        end: t.start + m.index + m[0].length,
      })),
    );
  const occupied = new Set(occurrences.map((p) => p.name));
  const content = bind(p.content, occurrences, (name, i) => {
    if (!seen.has(name)) {
      seen.add(name);
      return `:${name}`;
    }
    let renamed = `__compose_repeat_${i}_${name}`;
    while (occupied.has(renamed)) renamed = `_${renamed}`;
    occupied.add(renamed);
    renames.set(renamed, name);
    return `:${renamed}`;
  });
  p = { ...p, content };
  const module = await tooling.sqlModule(p.fileName, p.content);
  const cached = JSON.parse(await readFile(module.entry, "utf8")) as CachedAnalysis;
  stats.validated++;
  const digest = createHash("sha256")
    .update(JSON.stringify([cached.schema, cached.analysis]))
    .digest("hex");
  const key = JSON.stringify([
    p.projectHandle,
    projectIdentities.get(p.projectHandle),
    p.fileName,
    p.content,
    digest,
  ]);
  let transformed = typeCache.get(key);
  if (transformed) {
    stats.reused++;
    typeCache.delete(key);
    typeCache.set(key, transformed);
  } else {
    transformed = await handlers.transform(p);
    stats.transformed++;
    if (!transformed.diagnostics.length) {
      if (typeCache.size >= 2048) typeCache.delete(typeCache.keys().next().value!);
      typeCache.set(key, transformed);
    }
  }
  if (transformed.diagnostics.length)
    throw new Error(transformed.diagnostics.map((d) => d.messageText).join("\n"));
  const info = metadataFromCache(p.fileName, p.content, cached, module.code);
  let text = transformed.text;
  if (renames.size) {
    const mergedInputs = { ...info.inputs };
    for (const [from, to] of renames) {
      if (JSON.stringify(info.inputs?.[from]) !== JSON.stringify(info.inputs?.[to]))
        throw new Error(
          `Repeated parameter '${to}' has incompatible types or casts; use consistent casts or distinct names`,
        );
      delete mergedInputs[from];
    }
    info.inputs = mergedInputs;
    info.params = [...new Set(info.params.map((n) => renames.get(n) ?? n))];
    info.order = info.order?.map((n) => renames.get(n) ?? n);
    const params = alias(text, "Params");
    const mapping = [...renames]
      .map(([from, to]) => `${JSON.stringify(from)}: ${JSON.stringify(to)}`)
      .join(";");
    const mapped = `(${params}) extends infer P ? { [K in keyof P as K extends keyof {${mapping}} ? {${mapping}}[K] & string : K]: P[K] } : never`;
    text = text.replace(`export type Params = ${params};`, `export type Params = ${mapped};`);
  }
  return {
    text,
    queryError: alias(text, "QueryError"),
    info,
    noRows: cached.analysis.columns.length === 0,
  };
}

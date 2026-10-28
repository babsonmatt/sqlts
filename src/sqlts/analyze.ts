import { prepareCached } from "./prepared-cache.ts";
import {
  specializeResult,
  specializeWrappers,
  resultTypeHelpers,
  type ResultSpecialization,
} from "./result-types.ts";
import { sourceFingerprint } from "./shared-fragments.ts";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  alias,
  analyzeQuery,
  tooling,
  type Handlers,
  type TransformParams,
} from "../adapter/reylo.ts";
import { render } from "../parts.ts";
import { validatePlaceholders } from "../validate.ts";
import { normalizeGeneratedType } from "../generated-types.ts";
import { diagnosticRange } from "../diagnostics.ts";
import { offset, queryMarkdown } from "../preview.ts";
import type { Artifact } from "../runtime.ts";
import { applyEdits, mapOffset, mappings, prepare, type Edit } from "./transform.ts";

export interface SqltsDiagnostic {
  start: number;
  length: number;
  messageText: string;
  code: number;
}
export class SqltsError extends Error {
  readonly diagnostics: SqltsDiagnostic[];
  constructor(diagnostics: SqltsDiagnostic[]) {
    super(diagnostics.map((d) => d.messageText).join("\n"));
    this.diagnostics = diagnostics;
  }
}
const runtime = fileURLToPath(new URL("../runtime.ts", import.meta.url));
export async function analyze(
  p: TransformParams,
  handlers: Handlers,
  options: { specializeResults?: boolean; reusePreparation?: boolean } = {},
) {
  const prepared =
    options.reusePreparation === false
      ? prepare(p.content, p.fileName)
      : prepareCached(p.content, p.fileName);
  const { queries, analysis, sites, prefix, name, statement } = prepared;
  const fingerprint = `\nexport type __reyloSqltsSource = ${JSON.stringify(sourceFingerprint(p.content))};\n`;
  if (/\b__reyloSqltsSource\b/.test(p.content))
    throw Error("__reyloSqltsSource is reserved for shared SQLTS dependency checking");
  const artifact: Artifact = Object.create(null);
  const declarations: string[] = [];
  const specializations: Edit[] = [];
  const signatures: ResultSpecialization[] = [];
  const shapes = new Map<string, Awaited<ReturnType<typeof analyzeQuery>>>();
  for (const q of queries) {
    artifact[q.id] = Object.create(null);
    const inputs: string[] = [],
      rows: string[] = [];
    const cardinalities: string[] = [];
    const errors: string[] = [];
    const contracts = new Map<number, string>();
    for (const [index, parts] of q.variants.entries()) {
      validatePlaceholders(parts);
      const { named, values } = render(parts);
      const fileName = p.fileName + `.${q.id}.${index}.sql`;
      let result;
      try {
        result = shapes.get(named);
        if (!result) {
          result = await analyzeQuery({ ...p, fileName, content: named }, handlers);
          shapes.set(named, result);
        }
      } catch (error) {
        const failure = await handlers.transform({ ...p, fileName, content: named });
        const diagnostics = failure.diagnostics.map((d) => {
          const range = diagnosticRange(analysis.text, named, q.sourceMaps[index]!, d, q.start);
          const start = mapOffset(analysis, offset(analysis.text, range.start), true);
          const end = mapOffset(analysis, offset(analysis.text, range.end), true);
          return {
            start,
            length: Math.max(1, end - start),
            code: d.code,
            messageText: d.messageText,
          };
        });
        if (diagnostics.length) throw new SqltsError(diagnostics);
        throw error;
      }
      const expected = values.map((_, i) => `p${i}`);
      if (
        result.info.params.length !== expected.length ||
        expected.some((n) => !result.info.params.includes(n))
      )
        throw Error(
          "Interpolations must be SQL values outside quotes/comments; authored placeholders are unsupported",
        );
      const contract = JSON.stringify(expected.map((n) => result.info.inputs?.[n]));
      if (contracts.has(expected.length) && contracts.get(expected.length) !== contract)
        throw Error(
          "Ambiguous parameter types in conditional SQL shapes with equal binding counts",
        );
      contracts.set(expected.length, contract);
      const params = normalizeGeneratedType(alias(result.text, "Params"));
      inputs.push(
        `readonly [${expected.map((n) => `(${params})[${JSON.stringify(n)}]`).join(",")}]`,
      );
      errors.push(result.queryError);
      cardinalities.push(JSON.stringify(result.info.inferredCardinality ?? "many"));
      rows.push(result.noRows ? "never" : normalizeGeneratedType(alias(result.text, "Row")));
      artifact[q.id]![named] = { ...result.info, source: p.fileName };
    }
    const specialization =
      options.specializeResults === false
        ? undefined
        : specializeResult(
            prepared,
            q,
            rows,
            [...new Set(cardinalities)].join(" | "),
            [...new Set(errors)].join(" | "),
          );
    if (specialization) {
      signatures.push(specialization);
      specializations.push(...specialization.edits);
      declarations.push(...specialization.declarations);
    }
    const doc = queryMarkdown(q, false)
      .replace(`**Inline SQL: ${q.id}**`, "**Inline SQL**")
      .replace(
        "Run `bun run typecheck` for SQL and TypeScript checking.",
        "Checked in memory by the TypeScript content mapper; no generated source files.",
      )
      .replaceAll("*/", "* /")
      .split("\n")
      .map((l) => " * " + l)
      .join("\n");
    declarations.push(
      `/**\n${doc}\n */\ndeclare const ${prefix + q.id}: ${prefix}Tag<${[...new Set(inputs)].join(" | ")}, ${[...new Set(rows)].join(" | ")}, ${[...new Set(cardinalities)].join(" | ")}, ${[...new Set(errors)].join(" | ")}>;`,
    );
  }
  for (const signature of options.specializeResults === false
    ? []
    : specializeWrappers(prepared, signatures)) {
    specializations.push(...signature.edits);
    declarations.push(...signature.declarations);
  }
  if (!statement)
    return {
      text: p.content + fingerprint,
      extension: ".ts",
      mappings: mappings(analysis),
      diagnostics: [],
      runtime: p.content,
    };
  let runtimePath = relative(dirname(p.fileName), runtime).replaceAll("\\", "/");
  if (!runtimePath.startsWith(".")) runtimePath = "./" + runtimePath;
  const sourceFile = statement.getSourceFile();
  const start = statement.getStart(sourceFile),
    end = statement.end;
  const common = prepared.edits.filter(
    (e) => !(e.start >= start && e.end <= end) && !sites.some((s) => s.start === e.start),
  );
  const dependencyChecks = Object.entries(prepared.fingerprints ?? {}).map(([file, stamp], i) => {
    let path = relative(dirname(p.fileName), file).replaceAll("\\", "/");
    if (!path.startsWith(".")) path = "./" + path;
    return `type ${prefix}Dependency${i} = ${prefix}Fresh<import(${JSON.stringify(path)}).__reyloSqltsSource extends ${JSON.stringify(stamp)} ? true : "Shared SQL fragment changed: save its source and recheck/restart the SQLTS language server">;`;
  });
  const checking: Edit[] = [
    {
      start: p.content.length,
      end: p.content.length,
      text:
        fingerprint +
        (dependencyChecks.length
          ? `type ${prefix}Fresh<T extends true> = T;\n` + dependencyChecks.join("\n")
          : ""),
    },
    ...common,
    ...specializations,
    {
      start,
      end,
      text: `import type { Sql as ${prefix}Sql, QueryTag as ${prefix}Tag, Query as ${prefix}Query } from ${JSON.stringify(runtimePath)};\ndeclare const ${name}: ${prefix}Sql<Record<never,never>>;\n${specializations.length ? resultTypeHelpers(prefix) : ""}${declarations.join("\n")}\n`,
    },
    ...sites.map((s) => ({ start: s.start, end: s.end, text: s.tag })),
  ];
  const executing: Edit[] = [
    ...common,
    {
      start,
      end,
      text: `import { createSql as ${prefix}create } from ${JSON.stringify(runtimePath)};\nconst ${name} = ${prefix}create(${JSON.stringify(artifact)}, true);\n`,
    },
    ...sites.map((s) => ({
      start: s.start,
      end: s.end,
      text: `${name}.query(${JSON.stringify(s.id)})`,
    })),
  ];
  const virtual = applyEdits(p.content, p.fileName, checking);
  return {
    text: virtual.text,
    extension: ".ts",
    mappings: mappings(virtual),
    diagnostics: [],
    runtime: applyEdits(p.content, p.fileName, executing).text,
  };
}
export { tooling };

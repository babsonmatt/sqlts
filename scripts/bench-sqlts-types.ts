import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { position } from "../src/preview.ts";
import { client } from "../tests/lsp-client.ts";

// Synthetic development benchmark. It never runs the authored application queries.
// Includes existing-schema SQL validation; database and OS caches are not flushed.
const directory = await mkdtemp(resolve("work/sqlts-types-bench-"));
const config = resolve(directory, "tsconfig.json");
await mkdir(directory, { recursive: true });
await writeFile(
  config,
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "esnext",
      module: "preserve",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      noUncheckedIndexedAccess: true,
      types: ["node"],
    },
    contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
    include: ["*.ts", "*.sqlts"],
  }),
);
await writeFile(
  resolve(directory, "fragments.sqlts"),
  `import {sql} from "reylo-sqlts-experiment";
export function filters(a:boolean,b:boolean,c:boolean) {return sql.fragment\`\${sql.where(a && sql.fragment\`email IS NOT NULL\`, b && sql.fragment\`id > 1\`, c && sql.fragment\`name <> 'Bob'\`)}\`;}`,
);
const files = Array.from({ length: 8 }, (_, fileIndex) => ({
  file: resolve(directory, `queries${fileIndex}.sqlts`),
  source:
    `import {sql} from "reylo-sqlts-experiment";import {filters} from "./fragments.sqlts";\n` +
    Array.from(
      { length: 16 },
      (_, i) =>
        `export const query${i} = (a=false,b=false,c=false) => sql\`SELECT id,email FROM reylo_inline_demo.users \${filters(a,b,c)} ORDER BY id\`;`,
    ).join("\n"),
}));
for (const file of files) await writeFile(file.file, file.source);
const caller = resolve(directory, "caller.ts"),
  consumer = `import {query0} from "./queries0.sqlts";import type {PostgresClient} from "reylo";export async function inspect(db:PostgresClient){const rows=await query0(true,false,false).run(db);const email=rows[0]?.email;return email;}`;
await writeFile(caller, consumer);
const summary = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(2),
    p95Ms: +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!.toFixed(2),
    samplesMs: samples.map((v) => +v.toFixed(3)),
  };
};
const handlers = tooling.mapperHandlers(),
  projectHandle = "type-bench-" + crypto.randomUUID();
const samples = { unionOnly: [] as number[], specialized: [] as number[] };
const emitted = { unionOnly: 0, specialized: 0 };
try {
  await handlers.openProject({ projectHandle, configFileName: config });
  console.log("Measuring 128 query sites / 1,024 branch slots (8 distinct SQL shapes per file)...");
  // Warm both paths, then alternate ordering to reduce systematic cache/order bias.
  for (let round = -1; round < 7; round++)
    for (const enabled of round % 2 === 0 ? [true, false] : [false, true]) {
      const started = performance.now();
      let bytes = 0;
      for (const file of files) {
        const result = await analyze(
          { projectHandle, fileName: file.file, content: file.source },
          handlers,
          { specializeResults: enabled },
        );
        bytes += Buffer.byteLength(result.text);
      }
      const mode = enabled ? "specialized" : "unionOnly";
      emitted[mode] = bytes;
      if (round >= 0) samples[mode].push(performance.now() - started);
    }
} finally {
  await handlers.closeProject({ projectHandle });
  await tooling.releaseConnections();
}
const checks: number[] = [];
console.log("Measuring fresh checker processes with the existing analysis cache...");
for (let i = 0; i < 3; i++) {
  const start = performance.now(),
    p = Bun.spawn(
      [
        Bun.which("node")!,
        "--env-file=.env",
        "node_modules/typescript/bin/tsc",
        "--runExternalCode",
        "--pretty",
        "false",
        "-p",
        config,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code) throw Error(out + err);
  checks.push(performance.now() - start);
}
const hoverSamples: number[] = [],
  editSamples: number[] = [];
const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"], {
  DATABASE_URL: process.env.DATABASE_URL,
});
const uri = pathToFileURL(caller).href,
  rootUri = pathToFileURL(directory).href;
const hover = (text: string) =>
  lsp.request("textDocument/hover", {
    textDocument: { uri },
    position: position(text, text.indexOf("email=")),
  });
let initialHoverMs = 0;
try {
  await lsp.request("initialize", {
    processId: process.pid,
    initializationOptions: { runExternalCode: true },
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "type-bench" }],
    capabilities: { textDocument: { hover: { contentFormat: ["markdown"] } } },
  });
  lsp.notify("initialized", {});
  lsp.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: consumer },
  });
  let start = performance.now();
  const initial = JSON.stringify(await hover(consumer));
  initialHoverMs = performance.now() - start;
  if (!initial.includes("string | undefined"))
    throw Error("Benchmark did not infer the narrowed row type: " + initial);
  for (let i = 0; i < 20; i++) {
    start = performance.now();
    await hover(consumer);
    hoverSamples.push(performance.now() - start);
  }
  for (let i = 0; i < 10; i++) {
    const text = consumer.replace("query0(true", `query0(${i % 2 === 0 ? "false" : "true"}`);
    start = performance.now();
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: i + 2 },
      contentChanges: [{ text }],
    });
    const result = JSON.stringify(await hover(text));
    editSamples.push(performance.now() - start);
    const expected = i % 2 === 0 ? "string | null | undefined" : "string | undefined";
    if (!result.includes(expected)) throw Error("Stale hover: " + result);
  }
} finally {
  await lsp.close();
}
const report = {
  date: new Date().toISOString(),
  environment: {
    bun: Bun.version,
    node: Bun.spawnSync([Bun.which("node")!, "--version"])
      .stdout.toString()
      .trim(),
  },
  fixture: { files: 8, querySites: 128, branchSlots: 1024, distinctSqlPerFile: 8 },
  analysis: {
    unionOnly: summary(samples.unionOnly),
    specialized: summary(samples.specialized),
    emittedBytes: emitted,
  },
  freshCheckerWithCache: summary(checks),
  editor: {
    firstHoverMs: +initialHoverMs.toFixed(2),
    warmHover: summary(hoverSamples),
    argumentEditToHover: summary(editSamples),
  },
  methodology:
    "Synthetic existing-schema fixture; warm transform timings alternate baseline/specialized order. Fresh checker processes reuse SQL analysis/database/OS caches. LSP timings include JSON-RPC and typechecking; first hover includes initial project analysis. Warm edits change caller boolean arguments, not SQL/schema. No request-time benchmark: specialization changes checking output only.",
};
await writeFile(resolve(directory, "results.json"), JSON.stringify(report, null, 2));
console.table(
  [
    { phase: "transform: union only", ...summary(samples.unionOnly) },
    { phase: "transform: specialized", ...summary(samples.specialized) },
    { phase: "fresh checker (cached SQL)", ...summary(checks) },
    { phase: "warm hover", ...summary(hoverSamples) },
    { phase: "argument edit → hover", ...summary(editSamples) },
  ].map(({ phase, medianMs, p95Ms }) => ({ phase, medianMs, p95Ms })),
);
console.log(
  "First hover:",
  report.editor.firstHoverMs,
  "ms; full results:",
  resolve(directory, "results.json"),
);

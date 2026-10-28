import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepare } from "../src/sqlts/transform.ts";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";

const root = resolve(".");
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-test-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts"),
  caller = resolve(dir, "caller.ts");
const source = `import {sql} from "reylo-sqlts-experiment";
// 🎉 unicode and separate return types
export function ids(orgId:number) {return sql\`SELECT id FROM reylo_inline_demo.users WHERE org_id = \${orgId}\`;}
export function names(orgId:number) {return sql\`SELECT name,email FROM reylo_inline_demo.users WHERE org_id = \${orgId}\`;}
export function optional(orgId:number, search?:string, email = false) {return sql\`SELECT u.id, u.name FROM reylo_inline_demo.users u
\${sql.where(sql.fragment\`u.org_id = \${orgId}\`, search && sql.or(sql.fragment\`u.name ILIKE \${search}\`, sql.fragment\`u.email ILIKE \${search}\`), email && sql.fragment\`u.email IS NOT NULL\`)} ORDER BY u.id\`;}
`;
const consumer = `import type {PostgresClient} from "reylo";
import {ids,names} from "./queries.sqlts";
export async function run(db:PostgresClient) {
 const rows = await names(10).run(db);
 const idRows = await ids(10).run(db);
 const name = rows[0]?.name;
 const id = idRows[0]?.id;
 return {name,id};
}
`;
const config = {
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
  include: ["*.sqlts", "*.ts"],
};
await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(config));
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, a, b] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: a + b };
}
const check = () =>
  run([
    Bun.which("node")!,
    "--env-file=.env",
    "node_modules/typescript/bin/tsc",
    "--runExternalCode",
    "--pretty",
    "false",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);
const write = (text = source, code = consumer) =>
  Promise.all([writeFile(file, text), writeFile(caller, code)]);

test("sqlts transform distinguishes query/fragment tags and respects aliased and shadowed imports", () => {
  const p = prepare(
    'import {sql as s} from "reylo-sqlts-experiment"; function q(x:number){return s`SELECT id FROM users ${s.where(s.fragment`id = ${x}`)}`;} function other(s:any){return s`unrelated`;}',
    file,
  );
  expect(p.queries.length).toBe(1);
  expect(p.queries[0]!.variants.length).toBe(1);
  const nested = prepare(
    'import {sql} from "reylo-sqlts-experiment"; sql`SELECT (${sql`SELECT 1`})`',
    file,
  );
  expect(nested.queries).toHaveLength(1);
  expect(nested.sites).toHaveLength(1);
});

test("native checker infers distinct results, checks interpolation types, maps SQL errors and writes no generated source", async () => {
  await write();
  let result = await check();
  expect(result.code, result.output).toBe(0);
  await write(source, consumer.replace("rows[0]?.name", "rows[0]?.id"));
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Property 'id' does not exist");
  expect(result.output).toContain("caller.ts(6,");
  const wrong = source.replace("${orgId}", '${"wrong"}');
  await write(wrong);
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("queries.sqlts(3,");
  expect(result.output).toContain("invalidSqlParameters");
  const bad = source.replace("SELECT id", "SELECT id2");
  await write(bad);
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain('column "id2" does not exist');
  const loc = position(bad, bad.indexOf("id2"));
  expect(result.output).toContain(`queries.sqlts(${loc.line + 1},${loc.character + 1})`);
  await write();
  expect((await check()).code).toBe(0);
  // Reylo may persist analysis caches; it must not emit a TS/JS query module or .inline/.auto tree.
  const disk = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: true, onlyFiles: true }),
  );
  expect(disk.filter((p) => !p.startsWith(".reylo/")).sort()).toEqual([
    "caller.ts",
    "queries.sqlts",
    "tsconfig.json",
  ]);
}, 20_000);

test("native checker validates && input types and maps errors even in a disabled branch", async () => {
  try {
    await write(source.replace("u.name ILIKE ${search}", "u.name ILIKE ${123}"));
    let result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("invalidSqlParameters");
    const bad = source
      .replace("email && sql.fragment", "false && sql.fragment")
      .replace("u.email IS NOT NULL", "u.id2 IS NOT NULL");
    await write(bad);
    result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("column u.id2 does not exist");
    const loc = position(bad, bad.indexOf("id2"));
    expect(result.output).toContain(`queries.sqlts(${loc.line + 1},${loc.character + 1})`);
  } finally {
    await write();
  }
  expect((await check()).code).toBe(0);
}, 20_000);

test("analysis never executes application source and emits exact source mappings", async () => {
  const handlers = tooling.mapperHandlers(),
    projectHandle = "sqlts-test-" + crypto.randomUUID();
  try {
    await handlers.openProject({ projectHandle, configFileName: resolve(dir, "tsconfig.json") });
    const content = source + '\nthrow new Error("Must not execute during analysis");';
    const result = await analyze({ projectHandle, fileName: file, content }, handlers);
    expect(result.text).toContain("id: number");
    expect(result.text).toContain("name: string");
    expect(result.text).not.toContain(" as any");
    for (const [v, len, o, olen, kind] of result.mappings)
      if (kind === 0) {
        expect(len).toBe(olen);
        expect(result.text.slice(v!, v! + len!)).toBe(content.slice(o!, o! + olen!));
      }
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
});

test("Node and Bun execute .sqlts directly through loaders with pg, without a generated source directory", async () => {
  const runtimeFile = resolve(dir, "runtime.ts");
  await writeFile(
    runtimeFile,
    `import {Pool} from "pg";
import {deepEqual} from "node:assert/strict";
import {searchUsersShorthand} from "../../experiments/sqlts/queries.sqlts";
const db = new Pool({connectionString:process.env.DATABASE_URL});
try {
  for (const [search, email, ids] of [[undefined,false,[1,2,3]],["",false,[1,2,3]],["Alice",false,[1]],["",true,[1,3]],["team",false,[3]],["' OR TRUE; --",false,[]]] as const) {
    const rows = await searchUsersShorthand(10, search, email).run(db);
    deepEqual(rows.map(r=>r.id), ids);
  }
  console.log("Shorthand branches match PostgreSQL");
} finally { await db.end(); }
`,
  );
  for (const command of [
    [
      Bun.which("node")!,
      "--env-file=.env",
      "--import",
      "reylo-sqlts-experiment/register",
      "experiments/sqlts/demo.ts",
    ],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", "experiments/sqlts/demo.ts"],
  ]) {
    const result = await run(command);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Alice");
    expect(result.output).toContain("email: null");
    const branches = await run([...command.slice(0, -1), runtimeFile]);
    expect(branches.code, branches.output).toBe(0);
    expect(branches.output).toContain("Shorthand branches match PostgreSQL");
  }
  const files = await readdir(resolve("experiments/sqlts"));
  expect(files).not.toContain(".inline");
  expect(files).not.toContain(".auto");
  expect(files).not.toContain("dist");
}, 20_000);

test("native TypeScript LSP shows real cross-file types, source-tag docs and updates for unsaved SQL", async () => {
  await write();
  const publications: {
    uri: string;
    diagnostics: { message: string; range: { start: { line: number; character: number } } }[];
  }[] = [];
  const lsp = client(
    [Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"],
    { DATABASE_URL: process.env.DATABASE_URL },
    (method, params) => {
      if (method === "textDocument/publishDiagnostics")
        publications.push(params as (typeof publications)[number]);
    },
  );
  const uri = pathToFileURL(file).href,
    callerUri = pathToFileURL(caller).href,
    rootUri = pathToFileURL(dir).href;
  const hover = (target: string, text: string, needle: string) =>
    lsp.request("textDocument/hover", {
      textDocument: { uri: target },
      position: position(text, text.indexOf(needle)),
    });
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      initializationOptions: { runExternalCode: true },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "sqlts" }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          diagnostic: { dynamicRegistration: false },
        },
      },
    });
    lsp.notify("initialized", {});
    for (const [documentUri, text] of [
      [callerUri, consumer],
      [uri, source],
    ])
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri: documentUri, languageId: "typescript", version: 1, text },
      });
    expect(JSON.stringify(await hover(callerUri, consumer, "name ="))).toContain(
      "string | undefined",
    );
    expect(JSON.stringify(await hover(callerUri, consumer, "id ="))).toContain(
      "number | undefined",
    );
    expect(JSON.stringify(await hover(uri, source, "sql`"))).toContain("SELECT id");
    const optionalHover = JSON.stringify(await hover(uri, source, "sql`SELECT u.id"));
    expect(optionalHover).toContain("truthy: search");
    expect(optionalHover).toContain("falsy: search");
    expect(optionalHover).toContain("ILIKE $2");
    const completion = (await lsp.request("textDocument/completion", {
      textDocument: { uri: callerUri },
      position: position(consumer, consumer.indexOf("?.name") + 2),
    })) as { items: { label: string }[] };
    expect(completion.items.map((i) => i.label)).toContain("name");
    expect(completion.items.map((i) => i.label)).not.toContain("id");
    const changed = source.replace("SELECT name,email", "SELECT id,email");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    const after = (await lsp.request("textDocument/completion", {
      textDocument: { uri: callerUri },
      position: position(consumer, consumer.indexOf("?.name") + 2),
    })) as { items: { label: string }[] };
    expect(after.items.map((i) => i.label)).toContain("id");
    expect(after.items.map((i) => i.label)).not.toContain("name");
    const bad = source.replace("SELECT id", "SELECT id2");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: bad }],
    });
    const diagnostics = await lsp.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(JSON.stringify(diagnostics)).toContain("id2");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 4 },
      contentChanges: [{ text: source }],
    });
    expect(JSON.stringify(await hover(callerUri, consumer, "name ="))).toContain(
      "string | undefined",
    );
  } finally {
    await lsp.close();
  }
}, 30_000);

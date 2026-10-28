import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prepare } from "../src/sqlts/transform.ts";
import { render } from "../src/parts.ts";

await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-shared-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts");
const fragments = `import {sql as s} from "reylo-sqlts-experiment";
export function matches(search: string) {
 const pattern = \`%\${search}%\`;
 return s.fragment\`(u.name ILIKE \${pattern} OR u.email ILIKE \${pattern})\`;
}
export const contactable = s.fragment\`u.email IS NOT NULL\`;
export const tenant = (org: number) => s.fragment\`u.org_id = \${org}\`;
`;
const query = `import {sql} from "reylo-sqlts-experiment";
import {matches, contactable, tenant} from "./fragments.sqlts";
const minimum = (id: number) => sql.fragment\`u.id >= \${id}\`;
export function search(org: number, term?: string, email=false) {
 return sql\`SELECT u.id,u.name,u.email FROM reylo_inline_demo.users u
 \${sql.where(tenant(org), minimum(0), term && matches(term), email && contactable)} ORDER BY u.id\`;
}
`;
await writeFile(resolve(dir, "fragments.sqlts"), fragments);
await writeFile(file, query);
await writeFile(
  resolve(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "esnext",
      module: "preserve",
      moduleResolution: "bundler",
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["node"],
    },
    contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
    include: ["*.ts", "*.sqlts"],
  }),
);
async function run(args: string[]) {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, a, b] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: a + b };
}
const check = () =>
  run([
    Bun.which("node")!,
    "--env-file=.env",
    "node_modules/typescript/bin/tsc",
    "--noEmit",
    "--runExternalCode",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);

test("shared functions, arrow functions and constants expand in each consumer's SQL scope", () => {
  const p = prepare(query, file);
  expect(p.queries).toHaveLength(1);
  expect(p.queries[0]!.variants).toHaveLength(4);
  expect(p.dependencies).toEqual([resolve(dir, "fragments.sqlts")]);
  expect(p.queries[0]!.variants.map((v) => render(v).named).join("\n")).toContain("u.name ILIKE");
});
test("shared fragments check inputs/results and reject an invalid consumer alias", async () => {
  await writeFile(
    resolve(dir, "consumer.ts"),
    `import {search} from './queries.sqlts';
import type {PostgresClient} from 'reylo';
export async function go(db:PostgresClient) { const row=(await search(10,'Alice').run(db))[0]!; const id:number=row.id; const email:string|null=row.email; return {id,email}; }`,
  );
  let result = await check();
  expect(result.code, result.output).toBe(0);
  await writeFile(file, query.replace("tenant(org)", 'tenant("bad")'));
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("string");
  await writeFile(
    file,
    query
      .replace("users u", "users customer")
      .replace("SELECT u.id,u.name,u.email", "SELECT customer.id,customer.name,customer.email")
      .replace("ORDER BY u.id", "ORDER BY customer.id"),
  );
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("missing FROM-clause entry");
  await writeFile(file, query);
  await writeFile(
    resolve(dir, "fragments.sqlts"),
    fragments.replace("u.email IS NOT NULL", "u.id2 IS NOT NULL"),
  );
  result = await check();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("u.id2");
  await writeFile(resolve(dir, "fragments.sqlts"), fragments);
  expect((await check()).code).toBe(0);
}, 20_000);
test("cross-module fragment identity works on Node and Bun with independent parameter snapshots", async () => {
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {Pool} from 'pg'; import {deepEqual} from 'node:assert/strict'; import {search} from './queries.sqlts';
const db=new Pool({connectionString:process.env.DATABASE_URL});
try { for(const [term,email,ids] of [[undefined,false,[1,2,3]],['Alice',false,[1]],['team',false,[3]],[undefined,true,[1,3]],["' OR TRUE; --",false,[]]] as const) {
 const q=search(10,term,email); const rows=await q.run(db); deepEqual(rows.map(r=>r.id),ids);
 const compiled=q.compile(); deepEqual((await db.query(compiled.text,compiled.values)).rows,rows);
 } console.log('shared fragments verified'); } finally {await db.end();}`,
  );
  for (const command of [
    [Bun.which("node")!, "--env-file=.env", "--import", "reylo-sqlts-experiment/register", runner],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
  ]) {
    const r = await run(command);
    expect(r.code, r.output).toBe(0);
  }
}, 15_000);
test("recursive fragment helpers fail with a bounded diagnostic", () => {
  expect(() =>
    prepare(
      'import {sql} from "reylo-sqlts-experiment"; function f(){return sql.fragment`(${f()})`;} export const q=sql`SELECT 1 ${sql.where(f())}`;',
      file,
    ),
  ).toThrow("Recursive fragment");
});

test("shared fragment edits fail closed in the IDE until their saved dependency is reanalyzed", async () => {
  const { client } = await import("./lsp-client.ts");
  const { pathToFileURL } = await import("node:url");
  const { position } = await import("../src/preview.ts");
  const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const queryUri = pathToFileURL(file).href,
    sharedUri = pathToFileURL(resolve(dir, "fragments.sqlts")).href;
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      initializationOptions: { runExternalCode: true },
      capabilities: {},
    });
    lsp.notify("initialized", {});
    for (const [uri, text] of [
      [queryUri, query],
      [sharedUri, fragments],
    ])
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri, text, languageId: "typescript", version: 1 },
      });
    const hover = await lsp.request("textDocument/hover", {
      textDocument: { uri: queryUri },
      position: position(query, query.indexOf("return sql`") + 8),
    });
    expect(JSON.stringify(hover)).toContain("ILIKE");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: sharedUri, version: 2 },
      contentChanges: [{ text: fragments.replace("u.name ILIKE", "u.id2 ILIKE") }],
    });
    const diagnostics = await lsp.request("textDocument/diagnostic", {
      textDocument: { uri: queryUri },
    });
    expect(JSON.stringify(diagnostics)).toContain("Shared SQL fragment changed");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: sharedUri, version: 3 },
      contentChanges: [{ text: fragments }],
    });
    const restored = await lsp.request("textDocument/diagnostic", {
      textDocument: { uri: queryUri },
    });
    expect(JSON.stringify(restored)).not.toContain("Shared SQL fragment changed");
  } finally {
    await lsp.close();
  }
}, 15_000);

test("ordinary recursive value functions remain parameters and application code is never evaluated", () => {
  const source =
    'import {sql} from "reylo-sqlts-experiment"; function value(n:number):number {if(n<=0)return 0;return value(n-1);} export const q=sql`SELECT ${value(3)}::int AS answer`;throw new Error("do not evaluate");';
  expect(prepare(source, file).queries[0]!.variants).toHaveLength(1);
});

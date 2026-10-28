import { dependencyClient } from "./dependency-watch-client.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { position } from "../src/preview.ts";
import { CallPreviewService } from "../src/call-preview.ts";
const root = resolve(".");
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-reuse-types-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts"),
  shared = resolve(dir, "fragments.sqlts"),
  caller = resolve(dir, "caller.ts");
const fragments = `import {sql} from "reylo-sqlts-experiment";
export function emailRequired(enabled=true) {return sql.fragment\`\${enabled ? sql.fragment\`email IS NOT NULL\` : sql.empty}\`;}
export const nested = (switchOn:boolean) => emailRequired(switchOn);
export function inverse(flag:boolean) {const local = !flag;return emailRequired(local);}
let captured=false;
export function opaque(capturedArg:boolean) {return sql.fragment\`\${captured ? sql.fragment\`email IS NOT NULL\` : sql.empty}\`;}
export function mutating(flag:boolean) {const unused=(flag=false);return emailRequired(flag);}
export function logicalValue(flag:boolean) {const value=flag && "email";return sql.fragment\`\${value === "email" ? sql.empty : sql.fragment\`email IS NOT NULL\`}\`;}
export function projection(mode:"id"|"email"="id") {return sql.fragment\`\${mode === "id" ? sql.fragment\`id\` : sql.fragment\`email\`}\`;}
`;
const source =
  `import {sql} from "reylo-sqlts-experiment";
import {emailRequired,nested,inverse,opaque,mutating,projection,logicalValue} from "./fragments.sqlts";
export const arrow = (flag=false) => sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(emailRequired(flag))} ORDER BY id\`;
export const expression = function(flag=false) {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(nested(flag))}\`;};
export function local(flag=false) {const query = sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(emailRequired(flag))}\`; const result=query;return result;}
export function reverse(flag=false) {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(inverse(flag))}\`;}
export function defaults() {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(emailRequired(undefined))}\`;}
export function omitted() {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(emailRequired())}\`;}
export const choose=(mode:"id"|"email"="id")=>sql\`SELECT \${projection(mode)} FROM reylo_inline_demo.users\`;
export function collision(captured:boolean) {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(opaque(captured))}\`;}
export function logical(flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(logicalValue(flag))}\`;}
export function mutation(flag:boolean) {return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(mutating(flag))}\`;}
export const forwarded = (flag=false)=>arrow(flag);
export function wrapper(flag=false) {const enabled=flag;const query=forwarded(enabled);return query;}
export const reversedWrapper=(flag=false)=>wrapper(!flag);
export function defaultWrapper(){return wrapper(true);}
export function mutatedWrapper(flag:boolean){const ignored=(flag=false);return wrapper(flag);}
export function untouched(flag:boolean){if(flag)return arrow(true);return arrow(false);}
` +
  Array.from(
    { length: 18 },
    (_, i) => `export const level${i}=(flag=false)=>${i === 0 ? "arrow" : `level${i - 1}`}(flag);`,
  ).join("\n");
const consumer = `import {arrow,expression,local,reverse,defaults,omitted,choose,collision,mutation,forwarded,wrapper,reversedWrapper,defaultWrapper,mutatedWrapper,untouched,logical,level17} from "./queries.sqlts";
import type {PostgresClient} from "reylo";
export async function testTypes(db:PostgresClient,flag:boolean) {
 const strict = (await arrow(true).run(db))[0]?.email;
 const dynamic = (await wrapper(flag).run(db))[0]?.email;
 const definite:string|undefined=strict;
 const b:string|undefined=(await expression(true).run(db))[0]?.email;
 const c:string|undefined=(await local(true).run(db))[0]?.email;
 const d:string|undefined=(await reverse(false).run(db))[0]?.email;
 const e:string|undefined=(await defaults().run(db))[0]?.email;
 const f:string|undefined=(await omitted().run(db))[0]?.email;
 const id:number|undefined=(await choose().run(db))[0]?.id;
 const g:string|undefined=(await forwarded(true).run(db))[0]?.email;
 const h:string|undefined=(await wrapper(true).run(db))[0]?.email;
 const i:string|undefined=(await reversedWrapper(false).run(db))[0]?.email;
 const j:string|undefined=(await defaultWrapper().run(db))[0]?.email;
 // @ts-expect-error default false retains nullable rows
 const n:string|undefined=(await arrow().run(db))[0]?.email;
 // @ts-expect-error explicit undefined uses caller false default
 const n0:string|undefined=(await arrow(undefined).run(db))[0]?.email;
 // @ts-expect-error unknown runtime path stays nullable
 const n1:string|undefined=dynamic;
 // @ts-expect-error helper-captured state is not the same-named caller parameter
 const n2:string|undefined=(await collision(true).run(db))[0]?.email;
 // @ts-expect-error mutations in helper are not proven
 const n3:string|undefined=(await mutation(true).run(db))[0]?.email;
 // @ts-expect-error mutation in wrapper prevents specialization
 const n4:string|undefined=(await mutatedWrapper(true).run(db))[0]?.email;
 // @ts-expect-error runtime control flow retains union
 const n5:string|undefined=(await untouched(true).run(db))[0]?.email;
 // @ts-expect-error selected email projection has no id
 (await choose("email").run(db))[0]?.id;
 // @ts-expect-error logical expressions retain their value, not just boolean truthiness
 const n6:string|undefined=(await logical(true).run(db))[0]?.email;
 // @ts-expect-error deep forwarding chains fall back to their full inferred union
 const bounded:string|undefined=(await level17(true).run(db))[0]?.email;
 // @ts-expect-error helper parameter types remain checked
 arrow("yes");
 // @ts-expect-error explicit tuple cannot omit required true
 arrow<[true]>();
 return {strict,dynamic};
}`;
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
  include: ["*.sqlts", "caller.ts"],
};
await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(config));
async function write() {
  await Promise.all([
    writeFile(file, source),
    writeFile(shared, fragments),
    writeFile(caller, consumer),
  ]);
}
async function run(args: string[]) {
  const p = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, a, b] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
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

test("shared predicates, defaults, projections, arrows, local queries and forwarding wrappers preserve precise types", async () => {
  await write();
  const result = await check();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test("saved helper condition and default edits invalidate result types and SQL errors remain mapped", async () => {
  await write();
  try {
    await writeFile(shared, fragments.replace("enabled ?", "!enabled ?"));
    let result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("null");
    await writeFile(shared, fragments.replace("enabled=true", "enabled=false"));
    result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("caller.ts");
    await writeFile(shared, fragments.replace("email IS NOT NULL", "id2 IS NOT NULL"));
    result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('column "id2" does not exist');
    await writeFile(file, source.replace("emailRequired(flag)", "emailRequired(123)"));
    await writeFile(shared, fragments);
    result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("boolean | undefined");
  } finally {
    await write();
  }
  expect((await check()).code).toBe(0);
}, 20_000);

test("native IDE updates defaults, fails closed for unsaved helpers, and refreshes saved helper inference", async () => {
  await write();
  const lsp = dependencyClient();
  const uri = pathToFileURL(caller).href,
    quri = pathToFileURL(file).href,
    huri = pathToFileURL(shared).href,
    rootUri = pathToFileURL(dir).href;
  const hover = () =>
    lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: position(consumer, consumer.indexOf("strict =")),
    });
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      initializationOptions: { runExternalCode: true },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "reuse" }],
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
        textDocument: {
          hover: { contentFormat: ["markdown"] },
          diagnostic: { dynamicRegistration: false },
        },
      },
    });
    lsp.notify("initialized", {});
    for (const [u, text] of [
      [uri, consumer],
      [quri, source],
      [huri, fragments],
    ])
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri: u, languageId: "typescript", version: 1, text },
      });
    expect(JSON.stringify(await hover())).toContain("string | undefined");
    const defaultCall = consumer.replace("arrow(true)", "arrow()");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: defaultCall }],
    });
    expect(JSON.stringify(await hover())).toContain("string | null | undefined");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: quri, version: 2 },
      contentChanges: [{ text: source.replace("(flag=false) =>", "(flag=true) =>") }],
    });
    expect(JSON.stringify(await hover())).toContain("string | undefined");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: quri, version: 3 },
      contentChanges: [{ text: source }],
    });
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: consumer }],
    });
    const changed = fragments.replace("enabled ?", "!enabled ?");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: huri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    const diagnostic = await lsp.request("textDocument/diagnostic", {
      textDocument: { uri: quri },
    });
    expect(JSON.stringify(diagnostic)).toContain("Shared SQL fragment changed");
    await writeFile(shared, changed);
    lsp.notify("textDocument/didSave", { textDocument: { uri: huri } });
    // No consumer edit or manual refresh: the harness forwards actual registered watch events.
    let updated = "";
    for (let i = 0; i < 20; i++) {
      updated = JSON.stringify(await hover());
      if (updated.includes("string | null | undefined")) break;
      await Bun.sleep(100);
    }
    expect(updated).toContain("string | null | undefined");
    expect(lsp.notifications).toBeGreaterThan(0);
    const fresh = await lsp.request("textDocument/diagnostic", { textDocument: { uri: quri } });
    expect(JSON.stringify(fresh)).not.toContain("Shared SQL fragment changed");
  } finally {
    await lsp.close();
    await write();
  }
}, 20_000);

test("shared/default paths agree with PostgreSQL on Node and Bun; preview also follows proven helper defaults", async () => {
  await write();
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {Pool} from "pg";import {deepEqual} from "node:assert/strict";import {arrow,expression,local,reverse,defaults,omitted,choose,forwarded,wrapper,reversedWrapper,defaultWrapper} from "./queries.sqlts";
const db=new Pool({connectionString:process.env.DATABASE_URL});try{
for(const fn of [arrow,expression,local,forwarded,wrapper]) for(const flag of [true,false,undefined]) {const q=fn(flag),c=q.compile(); const rows=await q.run(db);deepEqual(rows,(await db.query(c.text,c.values)).rows);deepEqual(rows.some(r=>r.email===null),!flag);}
for(const q of [reverse(false),defaults(),omitted(),reversedWrapper(false),defaultWrapper()])deepEqual((await q.run(db)).some(r=>r.email===null),false);
for(const q of [choose(),choose("email")]) {const c=q.compile();deepEqual(await q.run(db),(await db.query(c.text,c.values)).rows);}
console.log("reuse branches match");}finally{await db.end();}`,
  );
  for (const args of [
    [Bun.which("node")!, "--env-file=.env", "--import", "reylo-sqlts-experiment/register", runner],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
  ]) {
    const result = await run(args);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("reuse branches match");
  }
  const text = 'import {defaults} from "./queries.sqlts"; defaults();',
    uri = pathToFileURL(caller).href;
  const preview = new CallPreviewService().hover(
    uri,
    position(text, text.lastIndexOf("defaults")),
    new Map([[uri, text]]),
  );
  expect(JSON.stringify(preview)).toContain("email IS NOT NULL");
  expect(JSON.stringify(preview)).toContain("one path");
  expect(JSON.stringify(preview)).not.toContain("sqlts:");
  for (const [name, args] of [
    ["wrapper", "true"],
    ["local", "true"],
    ["reversedWrapper", "false"],
    ["defaultWrapper", ""],
  ]) {
    const text = `import {${name}} from "./queries.sqlts"; ${name}(${args});`;
    const result = new CallPreviewService().hover(
      uri,
      position(text, text.lastIndexOf(name!)),
      new Map([[uri, text]]),
    );
    expect(JSON.stringify(result)).toContain("one path");
    expect(JSON.stringify(result)).toContain("email IS NOT NULL");
  }
}, 20_000);

test("arrow specialization preserves original body checks and emits no runtime helper", async () => {
  await write();
  const handlers = tooling.mapperHandlers(),
    projectHandle = "reuse-" + crypto.randomUUID();
  try {
    await handlers.openProject({ projectHandle, configFileName: resolve(dir, "tsconfig.json") });
    const result = await analyze({ projectHandle, fileName: file, content: source }, handlers);
    const baseline = await analyze({ projectHandle, fileName: file, content: source }, handlers, {
      specializeResults: false,
    });
    expect(result.runtime).toBe(baseline.runtime);
    expect(result.text).toContain("Specialize_q");
    expect(result.runtime).not.toContain("Specialize_q");
    expect(result.runtime).not.toContain("sqlts:");
    for (const [v, l, o, ol, k] of result.mappings)
      if (k === 0) {
        expect(l).toBe(ol);
        expect(result.text.slice(v!, v! + l!)).toBe(source.slice(o!, o! + ol!));
      }
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
});

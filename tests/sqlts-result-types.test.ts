import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";

const root = resolve(".");
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-result-types-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts"),
  caller = resolve(dir, "caller.ts");
const source = `import {sql} from "reylo-sqlts-experiment";
import {gate} from "./shared.sqlts";
export function users(orgId:number, onlyWithEmail=false) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(sql\`org_id = \${orgId}\`, onlyWithEmail && sql\`email IS NOT NULL\`)} ORDER BY id\`;
}
export function defaultTrue(flag=true) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)}\`;
}
export function choice(mode:"id"|"email"="id") {
  return sql\`SELECT \${mode === "id" ? sql\`id\` : sql\`email\`} FROM reylo_inline_demo.users\`;
}
export function numeric(mode:number) {
  return sql\`SELECT \${mode !== 1 ? sql\`id\` : sql\`email\`} FROM reylo_inline_demo.users\`;
}
export function combined(a:boolean,b:boolean) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where((a && !b) && sql\`email IS NOT NULL\`)}\`;
}
export function truthy(search?:string) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(search && sql\`email IS NOT NULL\`)}\`;
}
export function nullish(value:string|null|undefined) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(value != null && sql\`email IS NOT NULL\`)}\`;
}
export function aliased(flag:boolean) {
  const enabled = flag;
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(enabled && sql\`email IS NOT NULL\`)}\`;
}
export function opaque(flag:boolean) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where((flag && Math.random() > 0.5) && sql\`email IS NOT NULL\`)}\`;
}
export function mutated(flag:boolean) {
  const change = (() => { flag = !flag; })();
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)}\`;
}
export function shared(flag:boolean) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(gate(!flag))}\`;
}
export function shadowed(flag:boolean) {
  const enabled = ((flag:boolean) => flag)(false);
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(enabled && sql\`email IS NOT NULL\`)}\`;
}
export function initializerMutation(flag:boolean, other:boolean=(flag=false)) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)}\`;
}
export function priorDefault(flag=false, orgId:number) {
  return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(sql\`org_id = \${orgId}\`, flag && sql\`email IS NOT NULL\`)}\`;
}
`;
const consumer = `import {users,defaultTrue,choice,numeric,combined,truthy,nullish,aliased,opaque,mutated,shared,shadowed,priorDefault,initializerMutation} from "./queries.sqlts";
import type {PostgresClient} from "reylo";
export async function verify(db:PostgresClient, flag:boolean, mode:"id"|"email", text:string, maybe:boolean|undefined) {
  const yes = await users(10,true).run(db);
  const no = await users(10,false).run(db);
  const omitted = await users(10).run(db);
  const undef = await users(10,undefined).run(db);
  const dynamic = await users(10,flag).run(db);
  const maybeDefault = await users(10,maybe).run(db);
  const yesEmail = yes[0]?.email;
  const dynamicEmail = dynamic[0]?.email;
  const precise:string|undefined = yesEmail;
  // @ts-expect-error false does not eliminate null
  const e0:string|undefined = no[0]?.email;
  // @ts-expect-error omitted flag uses false
  const e1:string|undefined = omitted[0]?.email;
  // @ts-expect-error explicit undefined uses false
  const e2:string|undefined = undef[0]?.email;
  // @ts-expect-error runtime boolean keeps both paths
  const e3:string|undefined = dynamicEmail;
  // @ts-expect-error undefined can use the false default
  const e4:string|undefined = maybeDefault[0]?.email;
  const trueDefault:string|undefined = (await defaultTrue().run(db))[0]?.email;
  const trueUndefined:string|undefined = (await defaultTrue(undefined).run(db))[0]?.email;
  // @ts-expect-error explicit false overrides true default
  const e5:string|undefined = (await defaultTrue(false).run(db))[0]?.email;
  const id:number|undefined = (await choice().run(db))[0]?.id;
  const email:string|null|undefined = (await choice("email").run(db))[0]?.email;
  // @ts-expect-error id projection has no email
  (await choice("id").run(db))[0]?.email;
  // @ts-expect-error unknown projection can lack id
  (await choice(mode).run(db))[0]?.id;
  const numberChoice:number|undefined = (await numeric(2).run(db))[0]?.id;
  const numberEmail:string|null|undefined = (await numeric(1).run(db))[0]?.email;
  const and:string|undefined = (await combined(true,false).run(db))[0]?.email;
  // @ts-expect-error conjunction disabled
  const e6:string|undefined = (await combined(true,true).run(db))[0]?.email;
  const nonempty:string|undefined = (await truthy("abc").run(db))[0]?.email;
  // @ts-expect-error broad string might be empty
  const e7:string|undefined = (await truthy(text).run(db))[0]?.email;
  // @ts-expect-error empty disables filter
  const e8:string|undefined = (await truthy("").run(db))[0]?.email;
  const nonnull:string|undefined = (await nullish("").run(db))[0]?.email;
  // @ts-expect-error null disables filter
  const e9:string|undefined = (await nullish(null).run(db))[0]?.email;
  const alias:string|undefined = (await aliased(true).run(db))[0]?.email;
  // @ts-expect-error opaque condition must retain nullable result
  const e10:string|undefined = (await opaque(true).run(db))[0]?.email;
  // @ts-expect-error mutation prevents specialization
  const e11:string|undefined = (await mutated(true).run(db))[0]?.email;
  // @ts-expect-error expanded helper guards have different lexical bindings
  const e12:string|undefined = (await shared(true).run(db))[0]?.email;
  // @ts-expect-error same name in another scope does not imply same value
  const e13:string|undefined = (await shadowed(true).run(db))[0]?.email;
  // @ts-expect-error a default initializer can mutate a preceding argument
  const e16:string|undefined = (await initializerMutation(true).run(db))[0]?.email;
  const beforeRequired:string|undefined = (await priorDefault(true,10).run(db))[0]?.email;
  // @ts-expect-error false default before required param
  const e14:string|undefined = (await priorDefault(undefined,10).run(db))[0]?.email;
  // @ts-expect-error explicit type arguments cannot omit a required true value
  users<[number,true]>(10);
  // @ts-expect-error optional tuple member still includes the false default
  const e15:string|undefined = (await users<[number,true?]>(10).run(db))[0]?.email;
  // @ts-expect-error original parameter contracts are still checked
  users("wrong",true);
  // @ts-expect-error union domains still constrain callers
  choice("other");
  return {yesEmail,dynamicEmail};
}
type Row = Awaited<ReturnType<ReturnType<typeof users>["run"]>>[number];
const fullUnion:Row = {email:null};
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
  include: ["*.sqlts", "caller.ts"],
};
await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(config));
await writeFile(
  resolve(dir, "shared.sqlts"),
  'import {sql} from "reylo-sqlts-experiment"; export function gate(flag:boolean) {return sql.fragment`${flag ? sql.fragment`email IS NOT NULL` : sql.empty}`;}',
);
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
async function write(text = source, code = consumer) {
  await Promise.all([writeFile(file, text), writeFile(caller, code)]);
}

test("native checker specializes supplied flags, defaults and literal choices; unknowns remain unions", async () => {
  await write();
  const result = await check();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test("narrowing does not suppress SQL or binding diagnostics, including disabled paths", async () => {
  try {
    await write(source.replace("org_id = ${orgId}", 'org_id = ${"wrong"}'));
    let result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("invalidSqlParameters");
    await write(
      source.replace("onlyWithEmail && sql`email IS NOT NULL`", "false && sql`id2 IS NOT NULL`"),
    );
    result = await check();
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('column "id2" does not exist');
  } finally {
    await write();
  }
}, 20_000);

test("conditional return signatures are checking-only and preserve exact source mappings", async () => {
  const handlers = tooling.mapperHandlers(),
    projectHandle = "narrowing-" + crypto.randomUUID();
  try {
    await handlers.openProject({ projectHandle, configFileName: resolve(dir, "tsconfig.json") });
    const result = await analyze({ projectHandle, fileName: file, content: source }, handlers);
    expect(result.text).toContain("Args extends");
    expect(result.runtime).not.toContain("Args extends");
    expect(result.runtime).not.toContain("type __sqlts");
    expect(result.runtime).toContain("export function users(orgId:number, onlyWithEmail=false)");
    for (const [v, len, o, olen, kind] of result.mappings)
      if (kind === 0) {
        expect(len).toBe(olen);
        expect(result.text.slice(v!, v! + len!)).toBe(source.slice(o!, o! + olen!));
      }
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
});

test("native LSP shows narrowed consumer types and recalculates after unsaved argument changes", async () => {
  await write();
  const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = pathToFileURL(caller).href,
    rootUri = pathToFileURL(dir).href;
  const hover = (text: string, name: string) =>
    lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: position(text, text.indexOf(name)),
    });
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      initializationOptions: { runExternalCode: true },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "narrowing" }],
      capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } },
    });
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: consumer },
    });
    const yes = JSON.stringify(await hover(consumer, "yesEmail ="));
    expect(yes).toContain("string | undefined");
    expect(yes).not.toContain("null");
    expect(JSON.stringify(await hover(consumer, "dynamicEmail ="))).toContain(
      "string | null | undefined",
    );
    const changed = consumer.replace("users(10,true)", "users(10,false)");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    expect(JSON.stringify(await hover(changed, "yesEmail ="))).toContain(
      "string | null | undefined",
    );
  } finally {
    await lsp.close();
  }
}, 20_000);

test("Node and Bun runtime results match each specialized SQL branch", async () => {
  await write();
  const script = resolve(dir, "run.ts");
  await writeFile(
    script,
    `import {Pool} from "pg"; import {deepEqual} from "node:assert/strict";
import {users,defaultTrue,choice,numeric,combined,truthy,nullish,aliased,mutated,shared} from "./queries.sqlts";
const db=new Pool({connectionString:process.env.DATABASE_URL});
try {
 for(const value of [true,false,undefined]) {
  const query=users(10,value), compiled=query.compile();
  deepEqual(await query.run(db),(await db.query(compiled.text,compiled.values)).rows);
  deepEqual((await query.run(db)).map(r=>r.email),value ? ["alice@example.test","team@example.test"] : ["alice@example.test",null,"team@example.test"]);
 }
 for(const query of [defaultTrue(),choice(),choice("email"),numeric(1),numeric(2),combined(true,false),combined(true,true),truthy(""),truthy("abc"),nullish(null),nullish(""),aliased(true),mutated(true),shared(true)]) {
  const compiled=query.compile(); deepEqual(await query.run(db),(await db.query(compiled.text,compiled.values)).rows);
 }
 console.log("All narrowing branches match PostgreSQL");
} finally {await db.end();}`,
  );
  for (const command of [
    [Bun.which("node")!, "--env-file=.env", "--import", "reylo-sqlts-experiment/register", script],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", script],
  ]) {
    const result = await run(command);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("All narrowing branches");
  }
}, 20_000);

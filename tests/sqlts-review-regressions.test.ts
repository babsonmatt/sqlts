import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CallPreviewService } from "../src/call-preview.ts";
import { position } from "../src/preview.ts";
import { analyze, tooling } from "../src/sqlts/analyze.ts";
import { prepare } from "../src/sqlts/transform.ts";
import { client } from "./lsp-client.ts";
const root = resolve(".");
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-review-regressions-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const file = resolve(dir, "queries.sqlts"),
  helper = resolve(dir, "fragments.sqlts"),
  caller = resolve(dir, "caller.ts");
const fragments = `import {sql} from "reylo-sqlts-experiment";
const fallback=10;
let mutableFallback=99;
function forbidden():number {throw Error("Preview must not execute defaults");}
export function tenant(orgId=fallback){return sql.fragment\`org_id = \${orgId}\`;}
export function dynamicTenant(orgId=mutableFallback){return sql.fragment\`org_id = \${orgId}\`;}
export function unknownTenant(orgId=forbidden()){return sql.fragment\`org_id = \${orgId}\`;}
export function pair(a=10,b=a+1){return sql.fragment\`\${a}::int AS a, \${b}::int AS b\`;}
export function textValue(value:string="fallback"){return sql.fragment\`\${value}::text AS value\`;}
export function boolValue(value=true){return sql.fragment\`\${value}::boolean AS value\`;}
export function pattern(value="Alice"){const pattern=\`%\${value}%\`;return sql.fragment\`\${pattern}::text AS pattern\`;}
export function mutate(flag:boolean){const ignored=(()=>{for(flag of [false]){}})();return sql.fragment\`\${flag ? sql.fragment\`email IS NOT NULL\` : sql.empty}\`;}
export function nested(orgId?:number){return tenant(orgId);}
`;
const source = `import {sql} from "reylo-sqlts-experiment";
import {tenant,dynamicTenant,unknownTenant,pair,textValue,boolValue,pattern,mutate,nested} from "./fragments.sqlts";
type GlobalOrg=number;
export function clean(flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function loop(flag:boolean){const ignored=(()=>{for(flag of [false]){}})();return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function destructured(flag:boolean){const ignored=(()=>{for([flag] of [[false]] as [boolean][]){}})();return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function keys(flag:string){const ignored=(()=>{for(flag in {"":1}){}})();return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function shadow(flag:boolean){const ignored=(()=>{for(const flag of [false]){void flag;}})();return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)} ORDER BY id\`;}
export function forwarded(flag:boolean){const ignored=(()=>{for(flag of [false]){}})();return clean(flag);}
export function shared(flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(mutate(flag))} ORDER BY id\`;}
export function value(orgId?:number){return sql\`SELECT id FROM reylo_inline_demo.users \${sql.where(tenant(orgId))} ORDER BY id\`;}
export function nestedValue(orgId?:number){return sql\`SELECT id FROM reylo_inline_demo.users \${sql.where(nested(orgId))} ORDER BY id\`;}
export function captured(fallback:number){return sql\`SELECT id FROM reylo_inline_demo.users \${sql.where(tenant(undefined))} ORDER BY id\`;}
export function dynamic(mutableFallback:number){return sql\`SELECT id FROM reylo_inline_demo.users \${sql.where(dynamicTenant(undefined))}\`;}
export function unknown(){return sql\`SELECT id FROM reylo_inline_demo.users \${sql.where(unknownTenant(undefined))}\`;}
export function pairQuery(a?:number,b?:number){return sql\`SELECT \${pair(a,b)}\`;}
export function textQuery(value?:string){return sql\`SELECT \${textValue(value)}\`;}
export function boolQuery(value?:boolean){return sql\`SELECT \${boolValue(value)}\`;}
export function patternQuery(value?:string){return sql\`SELECT \${pattern(value)}\`;}
export function factory(){type OrgId=number;const query=(orgId:OrgId,flag:boolean)=>sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(sql\`org_id=\${orgId}\`,flag && sql\`email IS NOT NULL\`)}\`;return query;}
export function moduleType(orgId:GlobalOrg,flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(sql\`org_id=\${orgId}\`,flag && sql\`email IS NOT NULL\`)}\`;}
export function dependent(orgId:number,copy:typeof orgId,flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(sql\`org_id=\${copy}\`,flag && sql\`email IS NOT NULL\`)}\`;}
export function internalGeneric(cb:<T>(value:T)=>T,flag:boolean){return sql\`SELECT email FROM reylo_inline_demo.users \${sql.where(flag && sql\`email IS NOT NULL\`)}\`;}
`;
const consumer = `import type {PostgresClient} from "reylo";
import {clean,loop,destructured,keys,shadow,forwarded,shared,factory,moduleType,dependent,internalGeneric} from "./queries.sqlts";
export async function check(db:PostgresClient){
 const checkedEmail=(await clean(true).run(db))[0]?.email;
 const nonNull:string|undefined=checkedEmail;
 const shadowed:string|undefined=(await shadow(true).run(db))[0]?.email;
 const globalType:string|undefined=(await moduleType(10,true).run(db))[0]?.email;
 const ownGeneric:string|undefined=(await internalGeneric(<T>(value:T)=>value,true).run(db))[0]?.email;
 // @ts-expect-error for...of can change a parameter
 const a:string|undefined=(await loop(true).run(db))[1]?.email;
 // @ts-expect-error destructured loop targets also write parameters
 const b:string|undefined=(await destructured(true).run(db))[1]?.email;
 // @ts-expect-error for...in can change a string guard to an empty string
 const c:string|undefined=(await keys("yes").run(db))[1]?.email;
 // @ts-expect-error wrapper mutation prevents specialization
 const d:string|undefined=(await forwarded(true).run(db))[1]?.email;
 // @ts-expect-error helper mutation prevents specialization
 const e:string|undefined=(await shared(true).run(db))[1]?.email;
 const nested=factory();
 const nestedRows=await nested(10,true).run(db);
 const email:string|null|undefined=nestedRows[0]?.email;
 // @ts-expect-error locally scoped parameter types use the safe broad result
 const f:string|undefined=nestedRows[0]?.email;
 // @ts-expect-error original OrgId parameter contract remains number
 nested("bad",true);
 // @ts-expect-error typeof a function parameter cannot be hoisted
 const g:string|undefined=(await dependent(10,10,true).run(db))[0]?.email;
 return {checkedEmail,email};
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
  files: ["queries.sqlts", "fragments.sqlts", "caller.ts"],
};
await writeFile(resolve(dir, "tsconfig.json"), JSON.stringify(config));
await Promise.all([
  writeFile(file, source),
  writeFile(helper, fragments),
  writeFile(caller, consumer),
]);
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
function hover(name: string, args: string) {
  const text = `import {${name}} from "./queries.sqlts"; ${name}(${args});`,
    uri = pathToFileURL(caller).href;
  return (
    new CallPreviewService().hover(
      uri,
      position(text, text.lastIndexOf(name)),
      new Map([[uri, text]]),
    )?.contents.value ?? ""
  );
}

test("checker rejects unsafe narrowing after loop writes and preserves valid scoped type annotations", async () => {
  const result = await check();
  expect(result.code, result.output).toBe(0);
}, 20_000);

test("previews honor scalar defaults, captures, dependent defaults and falsy values without running code", () => {
  for (const name of ["value", "nestedValue"])
    for (const [args, expected] of [
      ["", "10"],
      ["undefined", "10"],
      ["0", "0"],
      ["20", "20"],
    ])
      expect(hover(name, args!)).toContain(`$1 = ${expected}`);
  expect(hover("captured", "77")).toContain("$1 = 10");
  expect(hover("dynamic", "77")).toContain("runtime value");
  expect(hover("dynamic", "77")).not.toContain("$1 = 77");
  expect(hover("unknown", "")).toContain("runtime value");
  expect(hover("unknown", "")).not.toContain("Preview must not execute defaults");
  expect(hover("value", "orgId")).toContain("runtime value");
  expect(hover("value", "orgId")).not.toContain("$1 = 10");
  for (const [args, a, b] of [
    ["", "10", "11"],
    ["undefined,undefined", "10", "11"],
    ["0,undefined", "0", "1"],
    ["20,7", "20", "7"],
  ]) {
    const preview = hover("pairQuery", args!);
    expect(preview).toContain(`$1 = ${a}`);
    expect(preview).toContain(`$2 = ${b}`);
  }
  for (const [args, value] of [
    ["undefined", '"fallback"'],
    ['""', '""'],
    ["null", "null"],
    ['"hello"', '"hello"'],
  ])
    expect(hover("textQuery", args!)).toContain(`$1 = ${value}`);
  expect(hover("boolQuery", "false")).toContain("$1 = false");
  expect(hover("boolQuery", "")).toContain("$1 = true");
  expect(hover("patternQuery", "undefined")).toContain('$1 = "%Alice%"');
  expect(hover("patternQuery", '"Bob"')).toContain('$1 = "%Bob%"');
  for (const name of ["loop", "destructured", "forwarded"])
    expect(hover(name, "true")).toContain("Mutated parameters remain unresolved");
  expect(hover("keys", '"yes"')).toContain("Mutated parameters remain unresolved");
  expect(hover("shared", "true")).toContain("2 possible paths");
  expect(hover("shadow", "true")).toContain("one path");
  expect(hover("value", "")).not.toContain("sqlts-value:");
});

test("runtime rows and scalar bindings agree with the fixed checks on Node and Bun", async () => {
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {Pool} from "pg";import {deepEqual} from "node:assert/strict";import {loop,destructured,keys,forwarded,shared,shadow,value,nestedValue,captured,pairQuery,textQuery,boolQuery,patternQuery,factory} from "./queries.sqlts";
 const db=new Pool({connectionString:process.env.DATABASE_URL});try{
 for(const q of [loop(true),destructured(true),keys("yes"),forwarded(true),shared(true)]){const c=q.compile();const rows=await q.run(db);deepEqual(rows,(await db.query(c.text,c.values)).rows);deepEqual(rows[1].email,null);}
 deepEqual((await shadow(true).run(db)).some(r=>r.email===null),false);
 for(const fn of [value,nestedValue])for(const [input,expected]of [[undefined,10],[0,0],[20,20]])deepEqual(fn(input).compile().values,[expected]);
 deepEqual(captured(77).compile().values,[10]);deepEqual(pairQuery().compile().values,[10,11]);deepEqual(pairQuery(0,undefined).compile().values,[0,1]);
 deepEqual(textQuery(null).compile().values,[null]);deepEqual(textQuery("").compile().values,[""]);deepEqual(textQuery().compile().values,["fallback"]);
 deepEqual(boolQuery(false).compile().values,[false]);deepEqual(boolQuery().compile().values,[true]);deepEqual(patternQuery().compile().values,["%Alice%"]);
 deepEqual((await factory()(10,true).run(db)).some(r=>r.email===null),false);console.log("review regressions match runtime");
 }finally{await db.end();}`,
  );
  for (const args of [
    [Bun.which("node")!, "--env-file=.env", "--import", "reylo-sqlts-experiment/register", runner],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
  ]) {
    const result = await run(args);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("review regressions match runtime");
  }
}, 20_000);

test("native LSP widens result types when an unsaved loop mutation is introduced", async () => {
  const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = pathToFileURL(caller).href,
    quri = pathToFileURL(file).href,
    rootUri = pathToFileURL(dir).href;
  const h = () =>
    lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: position(consumer, consumer.indexOf("checkedEmail=")),
    });
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      initializationOptions: { runExternalCode: true },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "regressions" }],
      capabilities: { textDocument: { hover: { contentFormat: ["markdown"] } } },
    });
    lsp.notify("initialized", {});
    for (const [u, text] of [
      [uri, consumer],
      [quri, source],
    ])
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri: u, languageId: "typescript", version: 1, text },
      });
    expect(JSON.stringify(await h())).toContain("string | undefined");
    const changed = source.replace(
      "export function clean(flag:boolean){return",
      "export function clean(flag:boolean){const ignored=(()=>{for(flag of [false]){}})();return",
    );
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: quri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    expect(JSON.stringify(await h())).toContain("string | null | undefined");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: quri, version: 3 },
      contentChanges: [{ text: source }],
    });
    expect(JSON.stringify(await h())).toContain("string | undefined");
  } finally {
    await lsp.close();
  }
}, 20_000);

test("binding provenance preserves runtime output and differentiates different default values", async () => {
  const handlers = tooling.mapperHandlers(),
    projectHandle = "review-regression-" + crypto.randomUUID();
  try {
    await handlers.openProject({ projectHandle, configFileName: resolve(dir, "tsconfig.json") });
    const result = await analyze({ projectHandle, fileName: file, content: source }, handlers);
    const baseline = await analyze({ projectHandle, fileName: file, content: source }, handlers, {
      specializeResults: false,
    });
    expect(result.runtime).toBe(baseline.runtime);
    expect(result.runtime).not.toContain("sqlts-value:");
    expect(result.text).not.toContain("sqlts-value:");
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
  const different = `import {sql} from "reylo-sqlts-experiment";function a(v=10){return sql.fragment\`\${v}::int AS id\`;}function b(v=20){return sql.fragment\`\${v}::int AS id\`;}export function q(flag:boolean){return sql\`SELECT \${flag?a(undefined):b(undefined)}\`;}`;
  expect(prepare(different, file).queries[0]!.variants).toHaveLength(2);
});

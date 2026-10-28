import { expect, test, afterAll } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CallPreviewService } from "../src/call-preview.ts";
import { position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";
const target = resolve("experiments/user-search/queries.sqlts");
const targetSource = await readFile(target, "utf8");
const caller = resolve("experiments/user-search/hover-test.ts");
const uri = pathToFileURL(caller).href,
  targetUri = pathToFileURL(target).href;
function hover(args: string, extra = "", sql = targetSource) {
  const source = `import {findUsers as find} from './queries.sqlts';\n${extra}\nexport function go(orgId:number, search?:string){ return find(${args}).run(db); }`;
  const docs = new Map([
    [uri, source],
    [targetUri, sql],
  ]);
  return (
    new CallPreviewService().hover(uri, position(source, source.lastIndexOf("find(") + 2), docs)
      ?.contents.value ?? ""
  );
}
test("literal call arguments select one path, compute bindings, and preserve unknown runtime values", () => {
  const text = hover('orgId, 10, "alice", true');
  expect(text).toContain("Resolved SQL structure: one path");
  expect(text).toContain("u.email IS NOT NULL");
  expect(text).toContain("ILIKE $2");
  expect(text).toContain("$1 = <orgId> (runtime value)");
  expect(text).toContain('$2 = "%alice%"');
  expect(text).toContain('$3 = "%alice%"');
  expect(text).toContain("$4 = 10");
});
test("defaults, const arguments, empty strings, zero and unknown guards stay honest", () => {
  const absent = hover('0, LIMIT, "", false', "const LIMIT = 5 + 5;");
  expect(absent).not.toContain("ILIKE");
  expect(absent).not.toContain("IS NOT NULL");
  expect(absent).toContain("$1 = 0");
  expect(absent).toContain("$2 = 10");
  const defaults = hover("10, 20");
  expect(defaults).not.toContain("ILIKE");
  expect(defaults).not.toContain("IS NOT NULL");
  const unknown = hover("orgId, 10, search, true");
  expect(unknown).toContain("2 possible paths");
  expect(unknown).not.toContain("Resolved SQL structure");
  const dynamic = hover("orgId, 10, calculateSearch(), true");
  expect(dynamic).toContain("2 possible paths");
});
test("lexical shadowing does not borrow outer constants and unrelated imports get no SQL hover", () => {
  const source = `import {findUsers} from './queries.sqlts';const search='alice';function go(search:string){return findUsers(10,20,search,true);}`;
  const docs = new Map([
    [uri, source],
    [targetUri, targetSource],
  ]);
  const service = new CallPreviewService();
  expect(
    service.hover(uri, position(source, source.lastIndexOf("findUsers(") + 1), docs)?.contents
      .value,
  ).toContain("2 possible paths");
  const shadow = `import {findUsers} from './queries.sqlts';function go(findUsers:Function){return findUsers(10,20,'alice',true);}`;
  docs.set(uri, shadow);
  expect(
    service.hover(uri, position(shadow, shadow.lastIndexOf("findUsers(") + 1), docs),
  ).toBeNull();
});
test("local template constants and nested conditions resolve, unsupported control flow remains explicit", () => {
  const sql =
    'import {sql} from "reylo-sqlts-experiment";export function findUsers(orgId:number, pageSize:number, search?:string, email=false){const pattern=`%${search}%`;return sql`SELECT id FROM users ${sql.where(sql`org_id=${orgId}`,search && (email ? sql`email ILIKE ${pattern}` : sql`name ILIKE ${pattern}`))} LIMIT ${pageSize}`;}';
  const text = hover('10,20,"alice",true', "", sql);
  expect(text).toContain("one path");
  expect(text).toContain("email ILIKE");
  expect(text).not.toContain("name ILIKE");
  expect(text).toContain('"%alice%"');
  const unsupported = sql.replace(
    "const pattern=",
    'if (email) throw Error("runtime"); const pattern=',
  );
  expect(hover('10,20,"alice",true', "", unsupported)).toContain(
    "runtime control flow remains unresolved",
  );
});
test("unsaved shared fragments participate and SQL-looking input remains a parameter", () => {
  const file = "/virtual/query.sqlts",
    callerFile = "/virtual/caller.ts",
    sharedFile = "/virtual/shared.sqlts";
  const source = 'import {findUsers} from "./query.sqlts";findUsers("x\' OR TRUE; --");';
  const docs = new Map([
    [pathToFileURL(callerFile).href, source],
    [
      pathToFileURL(file).href,
      'import {sql} from "reylo-sqlts-experiment";import {search} from "./shared.sqlts";export const findUsers=(q:string)=>sql`SELECT id FROM users WHERE ${search(q)}`;',
    ],
    [
      pathToFileURL(sharedFile).href,
      'import {sql} from "reylo-sqlts-experiment";export const search=(q:string)=>sql.fragment`name ILIKE ${`%${q}%`}`;',
    ],
  ]);
  const result =
    new CallPreviewService().hover(
      pathToFileURL(callerFile).href,
      position(source, source.lastIndexOf("findUsers(") + 1),
      docs,
    )?.contents.value ?? "";
  expect(result).toContain("WHERE name ILIKE $1");
  expect(result).toContain('$1 = "%x\' OR TRUE; --%"');
});
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/call-preview-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
test("preview LSP delivers call-site SQL and updates with unsaved arguments without a database", async () => {
  await writeFile(resolve(dir, "queries.sqlts"), targetSource);
  const documentUri = pathToFileURL(resolve(dir, "consumer.ts")).href;
  const source =
    'import {findUsers} from "./queries.sqlts";export function go(orgId:number){return findUsers(orgId,10,"alice",true).run(db);}';
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"], {
    DATABASE_URL: "",
  });
  try {
    await lsp.request("initialize", { capabilities: {} });
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri: documentUri, text: source, languageId: "typescript", version: 1 },
    });
    const request = () =>
      lsp.request("textDocument/hover", {
        textDocument: { uri: documentUri },
        position: position(source, source.lastIndexOf("findUsers(") + 1),
      });
    let value = JSON.stringify(await request());
    expect(value).toContain("%alice%");
    expect(value).toContain("IS NOT NULL");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri: documentUri, version: 2 },
      contentChanges: [{ text: source.replace('"alice",true', '"",false') }],
    });
    value = JSON.stringify(await request());
    expect(value).not.toContain("ILIKE");
    expect(value).not.toContain("IS NOT NULL");
    expect(value).toContain("one path");
  } finally {
    await lsp.close();
  }
}, 10_000);

test("resolved call previews agree with real compiled SQL and parameter values", async () => {
  const cases = [
    [10, 20, undefined, false],
    [10, 0, "", true],
    [10, 20, "alice", true],
    [10, 20, "x' OR TRUE; --", false],
  ] as const;
  const args = cases.map((values) =>
    values.map((v) => (v === undefined ? "undefined" : JSON.stringify(v))).join(","),
  );
  await writeFile(
    resolve(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {findUsers} from './queries.sqlts';console.log(JSON.stringify([${args.map((a) => `findUsers(${a}).compile()`).join(",")}]))`,
  );
  const child = Bun.spawn(
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, err).toBe(0);
  const compiled = JSON.parse(out) as { text: string; values: unknown[] }[];
  compiled.forEach((query, i) => {
    const preview = hover(args[i]!);
    const sql = /```sql\n([\s\S]*?)\n```/.exec(preview)?.[1];
    expect(sql).toBe(query.text.replace(/ \/\*file='[^']*'\*\/$/, "").trim());
    query.values.forEach((value, j) =>
      expect(preview).toContain(`$${j + 1} = ${JSON.stringify(value)}`),
    );
  });
}, 10_000);

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformAuto, mapOffset } from "../src/auto/transform.ts";
import {
  AutoGenerationError,
  buildAuto,
  mapCheckOutput,
  publishAuto,
  removeAuto,
} from "../src/auto/project.ts";
import { position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";

await mkdir("work", { recursive: true });
const root = await mkdtemp(resolve("work/auto-test-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const original = resolve(root, "queries.ts"),
  shadow = resolve(root, ".auto/test/queries.ts");
const header = 'import { sql } from "./sql.ts";\n';
const transform = (source: string, file = original) =>
  transformAuto(source, file, shadow, root, resolve(root, ".auto/test/.inline/sql.ts"));

test("auto identities distinguish sites, remain stable across unrelated edits and respect lexical bindings", () => {
  const query = "sql.auto`SELECT id FROM users`";
  const a = transform(header + query);
  expect(transform("// unrelated\n" + header + query).ids).toEqual(a.ids);
  expect(transform(header + query.replace("id", "name")).ids).not.toEqual(a.ids);
  expect(transform(header + query, resolve(root, "other.ts")).ids).not.toEqual(a.ids);
  expect(new Set(transform(header + query + ";" + query).ids).size).toBe(2);
  const alias = transform(
    'import { sql as s } from "./sql.ts"; s.auto`SELECT 1`; function f(s: any) { return s.auto`SELECT 2`; }',
  );
  expect(alias.ids.length).toBe(1);
  expect(alias.text).toContain("return s.auto`SELECT 2`");
  expect(() => transform(header + "sql.auto`SELECT ${sql.auto`SELECT 1`}`")).toThrow(
    "cannot be nested",
  );
});

test("static imports outside the mirror retain their original targets", () => {
  const f = transform(
    header +
      'import { helper } from "../helper.ts"; export { shared } from "../shared.ts"; sql.auto`SELECT 1`;',
  );
  expect(f.text).toContain('from "../../../helper.ts"');
  expect(f.text).toContain('from "../../../shared.ts"');
});

test("UTF-16 source maps preserve unchanged SQL and expressions, including CRLF", () => {
  const source = header + "// 🎉\r\nconst q = sql.auto`SELECT id WHERE id = ${value}`;\r\n";
  const f = transform(source);
  for (const token of ["SELECT", "id WHERE", "value"]) {
    const sourceAt = source.indexOf(token),
      generatedAt = f.text.indexOf(token);
    expect(mapOffset(f, sourceAt, false)).toBe(generatedAt);
    expect(mapOffset(f, generatedAt, true)).toBe(sourceAt);
  }
  expect(mapOffset(f, f.text.length, true)).toBe(source.length);
});

const queries =
  header +
  `
export function ids(org: number) { return sql.auto\`SELECT id FROM reylo_inline_demo.users WHERE org_id = \${org}\`; }
export function names(org: number) { return sql.auto\`SELECT name, email FROM reylo_inline_demo.users WHERE org_id = \${org}\`; }
`;
const consumerFile = resolve(root, "consumer.ts");
const consumer = `import type { PostgresClient } from "reylo";
import { ids, names } from "./queries.ts";
export async function consume(db: PostgresClient) {
  const rows = await names(10).run(db);
  const idRows = await ids(10).run(db);
  const name = rows[0]?.name;
  const id = idRows[0]?.id;
  return { name, id };
}
`;
async function check(directory: string) {
  const child = Bun.spawn(
    [process.execPath, "check", "--no-script", "-p", resolve(directory, "tsconfig.json")],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const [a, b, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: a + b };
}

test("Bun rejects wrong result properties and parameters with original source locations; invalid SQL preserves published snapshot", async () => {
  await writeFile(original, queries);
  await writeFile(consumerFile, consumer);
  const good = await buildAuto(root);
  expect((await check(good.directory)).code).toBe(0);
  await publishAuto(good);
  const pointer = await readFile(resolve(root, ".auto/current.json"), "utf8");
  const bad = await buildAuto(root, {
    [consumerFile]: consumer.replace("rows[0]?.name", "rows[0]?.id"),
    [original]:
      queries +
      '\nexport const bad = sql.auto`SELECT id FROM reylo_inline_demo.users WHERE org_id = ${"wrong"}`;',
  });
  const result = await check(bad.directory);
  expect(result.code).not.toBe(0);
  const mapped = mapCheckOutput(result.output, bad);
  expect(mapped).toContain(consumerFile + "(6,");
  expect(mapped).toContain(original);
  expect(mapped).toContain("Property 'id' does not exist");
  expect(mapped).toContain("invalidSqlParameters");
  await removeAuto(bad);
  let error: unknown;
  try {
    await buildAuto(root, { [original]: queries.replace("SELECT id", "SELECT id2") });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(AutoGenerationError);
  const diagnostic = (error as AutoGenerationError).diagnostics[0]!;
  expect(diagnostic.file).toBe(original);
  const edited = queries.replace("SELECT id", "SELECT id2");
  expect(diagnostic.diagnostic.range.start).toEqual(position(edited, edited.indexOf("id2")));
  expect(await readFile(resolve(root, ".auto/current.json"), "utf8")).toBe(pointer);
  await removeAuto(good);
}, 20_000);

test("editor maps real cross-file types, completions, SQL errors and unsaved result changes through LSP", async () => {
  await writeFile(original, queries);
  await writeFile(consumerFile, consumer);
  const published = new Map<
    string,
    { message: string; range: { start: { line: number; character: number } } }[]
  >();
  const c = client(
    [process.execPath, "scripts/auto-server.ts", "--project", root],
    { DATABASE_URL: process.env.DATABASE_URL },
    (method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        const p = params as {
          uri: string;
          diagnostics: { message: string; range: { start: { line: number; character: number } } }[];
        };
        published.set(p.uri, p.diagnostics);
      }
    },
  );
  const uri = pathToFileURL(original).href,
    consumerUri = pathToFileURL(consumerFile).href;
  const hover = (file: string, source: string, token: string) =>
    c.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(file).href },
      position: position(source, source.indexOf(token)),
    });
  try {
    await c.request("initialize", { rootUri: pathToFileURL(root).href, capabilities: {} });
    c.notify("initialized", {});
    for (const [file, text] of [
      [original, queries],
      [consumerFile, consumer],
    ])
      c.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToFileURL(file!).href,
          languageId: "typescript",
          version: 1,
          text,
        },
      });
    expect(JSON.stringify(await hover(consumerFile, consumer, "name ="))).toContain(
      "name: string | undefined",
    );
    expect(JSON.stringify(await hover(consumerFile, consumer, "id ="))).toContain(
      "id: number | undefined",
    );
    expect(published.get(consumerUri)).toEqual([]);
    expect(JSON.stringify(await hover(original, queries, "auto"))).toContain("SELECT");
    const complete = (await c.request("textDocument/completion", {
      textDocument: { uri: consumerUri },
      position: position(consumer, consumer.indexOf("?.name") + 2),
    })) as { items: { label: string }[] };
    expect(complete.items.map((i) => i.label)).toContain("name");
    expect(complete.items.map((i) => i.label)).not.toContain("id");
    const tokens = (await c.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })) as { data: number[] };
    expect(tokens.data.length).toBeGreaterThan(0);
    const changed = queries.replace("SELECT name, email", "SELECT id, email");
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: changed }],
    });
    await hover(consumerFile, consumer, "id =");
    expect(
      published.get(consumerUri)?.some((d) => d.message.includes("Property 'name' does not exist")),
    ).toBe(true);
    const broken = queries.replace("SELECT id", "SELECT id2");
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: broken }],
    });
    expect(await hover(consumerFile, consumer, "name =")).toBeNull();
    expect(published.get(uri)?.some((d) => d.message.includes("id2"))).toBe(true);
    const brokenCompletion = (await c.request("textDocument/completion", {
      textDocument: { uri },
      position: position(
        broken,
        broken.indexOf("reylo_inline_demo.") + "reylo_inline_demo.".length,
      ),
    })) as { items: { label: string }[] };
    expect(brokenCompletion.items.some((item) => item.label === "users")).toBe(true);

    // Rapid replacement cancels the old build and returns only the final revision.
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 4 },
      contentChanges: [{ text: broken }],
    });
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 5 },
      contentChanges: [{ text: queries }],
    });
    expect(JSON.stringify(await hover(consumerFile, consumer, "name ="))).toContain(
      "name: string | undefined",
    );
    expect(published.get(uri)).toEqual([]);
    expect(published.get(consumerUri)).toEqual([]);
  } finally {
    await c.close();
  }
}, 30_000);

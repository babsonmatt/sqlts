import { expect, test } from "bun:test";
import { SqltsSemanticTokens, tokenTypes } from "../src/sqlts/semantic-tokens.ts";
import { prepare } from "../src/sqlts/transform.ts";
import { offset, position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";
import { resolve } from "node:path";

function decode(source: string, data: number[]) {
  const out: { text: string; type: string; start: number }[] = [];
  let line = 0,
    character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    character = data[i] === 0 ? character + data[i + 1]! : data[i + 1]!;
    const start = offset(source, { line, character });
    out.push({
      text: source.slice(start, start + data[i + 2]!),
      type: tokenTypes[data[i + 3]!]!,
      start,
    });
  }
  return out;
}
const source =
  '// 🎉\r\nimport {sql as q} from "reylo-sqlts-experiment";\r\n' +
  "export function users(orgId:number,search?:string) { return q`\n" +
  "SELECT u.id FROM users u\n" +
  "WHERE u.org_id = ${orgId}\nORDER BY u.id\nLIMIT ${20}`; }\n" +
  "export function searchUsers(orgId:number,search?:string) { return q`\n" +
  "SELECT u.id, u.name FROM users u\n" +
  "${q.where(q.fragment`u.org_id = ${orgId}`, search ? q.fragment`u.name ILIKE ${`%${search}%`}` : undefined)}\n" +
  "ORDER BY u.id\nLIMIT ${20}`; }";

test("sqlts colors ORDER after each interpolation and nested fragment SQL while preserving JavaScript", () => {
  const service = new SqltsSemanticTokens();
  const result = service.full(source, "/example.sqlts");
  const tokens = decode(source, result.data);
  for (const match of source.matchAll(/\b(SELECT|FROM|WHERE|ORDER|BY|LIMIT|ILIKE)\b/g)) {
    expect(tokens).toContainEqual({ text: match[0], type: "keyword", start: match.index });
  }
  expect(
    tokens.filter((t) => t.text === "id" && t.type === "property").length,
  ).toBeGreaterThanOrEqual(4);
  expect(tokens.some((t) => /orgId|search|fragment|undefined|q\.where/.test(t.text))).toBe(false);
  expect(tokens.some((t) => t.text === "20")).toBe(false);
  expect(service.full(source, "/example.sqlts").data).toBe(result.data);
  service.close("/example.sqlts");
  expect(service.full(source, "/example.sqlts").data).not.toBe(result.data);
});

test("&& fragments retain SQL colors and leave guard expressions as JavaScript", () => {
  const text = source
    .replace("search ? q.fragment", "search && q.fragment")
    .replace(" : undefined", "");
  const tokens = decode(text, new SqltsSemanticTokens().full(text, "/example.sqlts").data);
  expect(tokens).toContainEqual({ text: "ILIKE", type: "keyword", start: text.indexOf("ILIKE") });
  expect(tokens.filter((t) => t.text === "ORDER")).toHaveLength(2);
  expect(tokens.some((t) => /search|&&|fragment/.test(t.text))).toBe(false);
});

test("highlighting stays tolerant while the authoritative mapper stays strict", () => {
  const service = new SqltsSemanticTokens();
  const unfinished =
    'import {sql} from "reylo-sqlts-experiment"; sql`SELECT u.id FROM users u WHERE u.id = ${id} ORDER BY u.id';
  const colors = decode(unfinished, service.full(unfinished, "/example.sqlts").data);
  expect(colors.some((t) => t.text === "ORDER" && t.type === "keyword")).toBe(true);
  expect(() => prepare(unfinished, "/example.sqlts")).toThrow();
  const syntaxElsewhere = source + "\nconst unfinished = (";
  expect(
    decode(syntaxElsewhere, service.full(syntaxElsewhere, "/example.sqlts").data).filter(
      (t) => t.text === "ORDER",
    ),
  ).toHaveLength(2);
});

test("sqlts coloring ignores unrelated and shadowed tags and clears unsupported documents", () => {
  const service = new SqltsSemanticTokens();
  for (const text of [
    'import {sql} from "other"; sql`SELECT 1`;',
    'import {sql} from "reylo-sqlts-experiment"; function f(sql:any) {return sql`SELECT 1`}',
  ])
    expect(service.full(text, "/example.sqlts").data).toEqual([]);
  expect(service.full(source, "/example.ts").data).toEqual([]);
  expect(service.full(source, "/example.sqlts").data.length).toBeGreaterThan(0);
  expect(service.full("x".repeat(500_001), "/example.sqlts").data).toEqual([]);
});

test("Node highlighting LSP handles split frames, unsaved UTF-16 edits, stale versions and close without a database", async () => {
  const lsp = client([Bun.which("node")!, resolve("src/sqlts/color-server.ts")]);
  const uri = "file:///example.sqlts";
  try {
    const capabilities = await lsp.request("initialize", { capabilities: {} }, true);
    expect(JSON.stringify(capabilities)).toContain("semanticTokensProvider");
    expect(JSON.stringify(capabilities)).not.toContain("hoverProvider");
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });
    const full = async () =>
      (await lsp.request("textDocument/semanticTokens/full", { textDocument: { uri } })) as {
        data: number[];
      };
    expect(decode(source, (await full()).data).filter((t) => t.text === "ORDER")).toHaveLength(2);
    const start = source.indexOf("ORDER"),
      end = start + "ORDER BY u.id".length;
    const edited = source.slice(0, start) + "GROUP BY u.id" + source.slice(end);
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: position(source, start), end: position(source, end) },
          text: "GROUP BY u.id",
        },
      ],
    });
    expect(
      decode(edited, (await full()).data).some((t) => t.text === "GROUP" && t.type === "keyword"),
    ).toBe(true);
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 1 },
      contentChanges: [{ text: source }],
    });
    expect(decode(edited, (await full()).data).some((t) => t.text === "GROUP")).toBe(true);
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
    expect((await full()).data).toEqual([]);
  } finally {
    await lsp.close();
  }
}, 15_000);

test("nested sql shorthand retains SQL coloring and leaves tag names and JavaScript alone", () => {
  const text = source.replaceAll("q.fragment`", "q`");
  const tokens = decode(text, new SqltsSemanticTokens().full(text, "/example.sqlts").data);
  expect(tokens).toContainEqual({ text: "ILIKE", type: "keyword", start: text.indexOf("ILIKE") });
  expect(tokens.filter((t) => t.text === "ORDER")).toHaveLength(2);
  expect(tokens.some((t) => /orgId|search|undefined|q/.test(t.text))).toBe(false);
});

test("mutation templates retain SQL colors across shared calls and conditional assignments without resolving imports", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(resolve("experiments/shared-queries/mutations.sqlts"), "utf8");
  // There is deliberately no file or imported fragments module at this URI.
  const uri = "file:///virtual/no-files/mutations.sqlts";
  const tokens = decode(text, new SqltsSemanticTokens().full(text, uri).data);
  for (const match of text.matchAll(
    /\b(INSERT|INTO|VALUES|UPDATE|AS|SET|NULL|WHERE|AND|RETURNING|ON|CONFLICT|DO|DELETE|FROM|SELECT)\b/g,
  ))
    expect(tokens).toContainEqual({ text: match[0], type: "keyword", start: match.index });
  expect(tokens.some((t) => /inOrganization|orgId|clearEmail|sql|empty/.test(t.text))).toBe(false);
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"], {
    DATABASE_URL: "",
  });
  try {
    await lsp.request("initialize", { capabilities: {} });
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, text, version: 1, languageId: "typescript" },
    });
    const result = (await lsp.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })) as { data: number[] };
    expect(decode(text, result.data)).toEqual(tokens);
  } finally {
    await lsp.close();
  }
}, 10_000);

test("standalone shared fragments and queries beyond the analysis shape budget still color lexically", () => {
  const text =
    'import {sql} from "reylo-sqlts-experiment";export const piece=sql.fragment`email IS NOT NULL`;export const query=sql`SELECT id FROM users ${sql.where(' +
    Array.from({ length: 10 }, (_, i) => `flags[${i}] && sql\`id > \${${i}}\``).join(",") +
    ")} ORDER BY id RETURNING id`;";
  const tokens = decode(text, new SqltsSemanticTokens().full(text, "/example.sqlts").data);
  for (const match of text.matchAll(/\b(IS|NOT|NULL|SELECT|FROM|ORDER|BY|RETURNING)\b/g))
    expect(tokens).toContainEqual({ text: match[0], type: "keyword", start: match.index });
  expect(tokens.some((t) => /flags|piece|fragment|sql/.test(t.text))).toBe(false);
  expect(() => prepare(text, "/example.sqlts")).toThrow("64 SQL shapes");
});

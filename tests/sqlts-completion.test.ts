import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CompletionService, type CompletionList } from "../src/completion.ts";
import type { Catalog } from "../src/catalog.ts";
import { offset, position } from "../src/preview.ts";
import { client } from "./lsp-client.ts";

const catalog: Catalog = {
  schemas: ["reylo_inline_demo"],
  keywords: ["order"],
  relations: [
    {
      schema: "reylo_inline_demo",
      name: "users",
      visible: false,
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "name", type: "text", nullable: false },
        { name: "email", type: "text", nullable: true },
        { name: "Order", type: "text", nullable: true },
      ],
    },
  ],
};
const preamble = '// 🌍\r\nimport {sql as q} from "reylo-sqlts-experiment";\r\n';
const service = new CompletionService();
function ask(marked: string) {
  const cursor = marked.indexOf("▌");
  const source = marked.replace("▌", "");
  const result = service.complete(
    source,
    "file:///space%20here/queries.sqlts",
    position(source, cursor),
    catalog,
  );
  return { source, result, labels: result.items.map((i) => i.label) };
}
const query = (sql: string) => preamble + "q`" + sql + "`;";

test("sqlts offers schemas/tables while SQL is incomplete and replaces only the typed identifier", () => {
  expect(ask(query("SELECT * FROM ▌")).labels).toContain("reylo_inline_demo.users");
  expect(ask(query("SELECT * FROM reylo_inline_demo.▌")).labels).toEqual(["users"]);
  for (const body of [
    "SELECT * FROM reylo_inline_demo.user▌ u",
    "SELECT * FROM reylo_inline_demo.us▌er u",
  ]) {
    const { source, result } = ask(query(body));
    const edit = result.items[0]!.textEdit;
    expect(source.slice(offset(source, edit.range.start), offset(source, edit.range.end))).toBe(
      "user",
    );
    expect(edit.newText).toBe("users");
  }
  expect(ask(preamble + "q`SELECT * FROM reylo_inline_demo.us▌").labels).toEqual(["users"]);
});

test("sqlts maps aliases and nested fragments back through transformed tags and interpolations", () => {
  for (const body of [
    "SELECT u.▌ FROM reylo_inline_demo.users u WHERE u.id = ${orgId}",
    "SELECT * FROM reylo_inline_demo.users u ${q.where(q.fragment`u.id = ${orgId}`, search && q.fragment`u.em▌`)}",
    "SELECT * FROM reylo_inline_demo.users u ${q.where(q`u.id = ${orgId}`, search && q`u.em▌`)}",
    "SELECT * FROM reylo_inline_demo.users u WHERE u.id = ${orgId} ORDER BY u.em▌",
  ]) {
    const { source, result, labels } = ask(query(body));
    expect(labels).toContain("email");
    const edit = result.items.find((i) => i.label === "email")!.textEdit;
    const prior = source.slice(offset(source, edit.range.start), offset(source, edit.range.end));
    expect(["", "em"]).toContain(prior);
    expect(
      source.slice(0, offset(source, edit.range.start)) +
        edit.newText +
        source.slice(offset(source, edit.range.end)),
    ).toContain("u.email");
  }
  expect(
    ask(query("SELECT u.Ord▌ FROM reylo_inline_demo.users u")).result.items[0]!.textEdit.newText,
  ).toBe('"Order"');
});

test("sqlts reuses CTE/subquery scope inference without leaking other aliases", () => {
  const cte = ask(
    query(
      "WITH recent AS (SELECT id, name AS display_name FROM reylo_inline_demo.users) SELECT r.▌ FROM recent r",
    ),
  );
  expect(cte.labels).toEqual(["id", "display_name"]);
  expect(ask(query("SELECT s.▌ FROM (SELECT id FROM reylo_inline_demo.users) s")).labels).toEqual([
    "id",
  ]);
  expect(ask(query("SELECT x.▌ FROM reylo_inline_demo.users u")).labels).toEqual([]);
});

test("sqlts completion stays out of JavaScript, SQL strings/comments, unrelated imports and shadowed tags", () => {
  for (const body of [
    "SELECT * FROM reylo_inline_demo.users WHERE id = ${org▌Id}",
    "SELECT * FROM reylo_inline_demo.users ${q.where(sear▌ch && q.fragment`id = 1`)}",
    "SELECT 'u.▌' FROM reylo_inline_demo.users u",
    "SELECT 1 /* u.▌ */ FROM reylo_inline_demo.users u",
  ])
    expect(ask(query(body)).labels).toEqual([]);
  expect(
    ask('import {sql as q} from "other"; q`SELECT * FROM reylo_inline_demo.▌`').labels,
  ).toEqual([]);
  expect(
    ask(preamble + "function f(q: unknown) { return q`SELECT * FROM reylo_inline_demo.▌`; }")
      .labels,
  ).toEqual([]);
  service.close("file:///space%20here/queries.sqlts");
  expect(ask(query("SELECT * FROM reylo_inline_demo.▌")).labels).toEqual(["users"]);
});

test("SQLTS completion LSP uses the live catalog, unsaved versions and leaves diagnostics to TypeScript", async () => {
  const publications: unknown[] = [];
  const lsp = client(
    [process.execPath, "--no-env-file", "scripts/preview-server.ts"],
    {
      DATABASE_URL: process.env.DATABASE_URL,
    },
    (method, params) => {
      if (method === "textDocument/publishDiagnostics") publications.push(params);
    },
  );
  const uri = pathToFileURL(resolve("experiments/user-search/completion-unsaved.sqlts")).href;
  let version = 0;
  let lastSource = "";
  const request = async (sql: string, method = "textDocument/completion") => {
    const marked = query(sql);
    const cursor = marked.indexOf("▌");
    lastSource = marked.replace("▌", "");
    if (++version === 1)
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version, text: lastSource },
      });
    else
      lsp.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: lastSource }],
      });
    return lsp.request(method, { textDocument: { uri }, position: position(lastSource, cursor) });
  };
  try {
    const capabilities = await lsp.request("initialize", {});
    expect(JSON.stringify(capabilities)).toContain("completionProvider");
    const table = (await request("SELECT * FROM reylo_inline_demo.user▌ u")) as CompletionList;
    expect(table.items.find((i) => i.label === "users")?.textEdit.newText).toBe("users");
    const nested = (await request(
      "SELECT * FROM reylo_inline_demo.users u ${q.where(q.fragment`u.id = ${orgId}`, search && q.fragment`u.em▌`)}",
    )) as CompletionList;
    expect(nested.items.map((i) => i.label)).toContain("email");
    const short = (await request(
      "SELECT * FROM reylo_inline_demo.users u ${q.where(q`u.id = ${orgId}`, search && q`u.em▌`)}",
    )) as CompletionList;
    expect(short.items.map((i) => i.label)).toContain("email");
    const signature = await request(
      "SELECT lower(▌name) FROM reylo_inline_demo.users",
      "textDocument/signatureHelp",
    );
    expect(JSON.stringify(signature)).toContain("lower(text)");
    const noSql = (await request(
      "SELECT id FROM reylo_inline_demo.users WHERE id = ${org▌Id}",
    )) as CompletionList;
    expect(noSql.items).toEqual([]);
    await request("SELECT u.▌ FROM reylo_inline_demo.users u");
    const at = position(lastSource, lastSource.indexOf("u.") + 2);
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: version - 1 },
      contentChanges: [{ text: "invalid stale text" }],
    });
    const current = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: at,
    })) as CompletionList;
    expect(current.items.map((i) => i.label)).toContain("email");
    const tokens = (await lsp.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })) as { data: number[] };
    expect(tokens.data.length).toBeGreaterThan(0);
    expect(publications).toEqual([]);
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
    const closed = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: at,
    })) as CompletionList;
    expect(closed.items).toEqual([]);
  } finally {
    await lsp.close();
  }
}, 20_000);

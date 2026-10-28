import { expect, test } from "bun:test";
import { SqlSemanticTokens, tokenTypes } from "../src/semantic-tokens.ts";
import { offset } from "../src/preview.ts";
function decode(source: string, data: number[]) {
  const out: { text: string; type: string }[] = [];
  let line = 0,
    character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    character = data[i] === 0 ? character + data[i + 1]! : data[i + 1]!;
    const at = offset(source, { line, character });
    out.push({ text: source.slice(at, at + data[i + 2]!), type: tokenTypes[data[i + 3]!]! });
  }
  return out;
}
test("SQL colors preserve JS interpolations, comments, Unicode and conditional fragment boundaries", () => {
  const source =
    '// 🌍\r\nimport {sql} from "../.inline/sql.ts"; sql.query("x")`SELECT u.id, lower(u.name) FROM users u ${sql.where(flag ? sql`u.id = ${userId}` : undefined)} /* hi\nthere */`';
  const service = new SqlSemanticTokens();
  const result = service.full(source, "/x.ts");
  const tokens = decode(source, result.data);
  expect(tokens).toContainEqual({ text: "SELECT", type: "keyword" });
  expect(tokens).toContainEqual({ text: "lower", type: "function" });
  expect(tokens).toContainEqual({ text: "id", type: "property" });
  expect(tokens.filter((t) => t.type === "comment").map((t) => t.text)).toEqual([
    "/* hi",
    "there */",
  ]);
  expect(tokens.some((t) => /userId|flag|undefined|sql/.test(t.text))).toBe(false);
  expect(service.full(source, "/x.ts").data).toBe(result.data);
  expect(service.full(source.replace("SELECT", "DELETE"), "/x.ts").data).not.toBe(result.data);
});
test("coloring never applies to unrelated/shadowed tags and tolerates incomplete templates", () => {
  const service = new SqlSemanticTokens();
  expect(service.full('import {sql} from "other"; sql.query("x")`SELECT x`', "/x.ts").data).toEqual(
    [],
  );
  const source =
    'import {sql} from "../.inline/sql.ts"; function f(sql: any) { sql.query("x")`SELECT x`; }';
  expect(service.full(source, "/x.ts").data).toEqual([]);
  expect(
    decode(
      'import {sql} from "../.inline/sql.ts"; sql.query("x")`SELECT',
      service.full('import {sql} from "../.inline/sql.ts"; sql.query("x")`SELECT', "/x.ts").data,
    ),
  ).toContainEqual({ text: "SELECT", type: "keyword" });
});

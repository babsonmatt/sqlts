import { expect, test } from "bun:test";
import { PreviewService, position, offset, queryMarkdown } from "../src/preview.ts";
import { extract } from "../src/extract.ts";

const uri = "file:///virtual/queries.ts";
const prelude = 'import { sql } from "../.inline/sql.ts";\n';
const sample =
  prelude +
  'sql.query("x")`SELECT id FROM users ${sql.where(sql`org_id = ${orgId}`, search ? sql`name ILIKE ${pattern}` : undefined)}`';
test("full alternatives, conditions, and symbolic bindings are visible", () => {
  const service = new PreviewService();
  service.documents.set(uri, sample);
  const markdown = service.hover(uri, position(sample, sample.indexOf(".query") + 2))!.contents
    .value;
  expect(markdown).toContain("2 possible source path(s)");
  expect(markdown).toContain("truthy: search");
  expect(markdown).toContain("falsy: search");
  expect(markdown).toContain("WHERE (org_id = $1) AND (name ILIKE $2)");
  expect(markdown).toContain("$2 ← pattern");
  expect(markdown).toContain("SQL validation appears separately in editor diagnostics");
});
test("unsaved content replaces cached previews; repeated hovers reuse parsing", () => {
  const service = new PreviewService();
  service.documents.set(uri, sample);
  const at = position(sample, sample.indexOf(".query") + 2);
  service.hover(uri, at);
  service.hover(uri, at);
  expect(service.parses).toBe(1);
  service.documents.set(uri, sample.replace("name ILIKE", "email ILIKE"));
  expect(service.hover(uri, at)!.contents.value).toContain("email ILIKE $2");
  expect(service.parses).toBe(2);
  service.close(uri);
  expect(service.hover(uri, at)).toBeNull();
});
test("nested conditions preserve branch provenance", () => {
  const q = extract(
    prelude +
      'sql.query("x")`SELECT 1 ${sql.where(a ? (b ? sql`x = ${one}` : sql`y = ${two}`) : undefined)}`',
    uri,
  )[0]!;
  expect(q.alternatives.map((v) => v.conditions)).toEqual([
    ["truthy: a", "truthy: b"],
    ["truthy: a", "falsy: b"],
    ["falsy: a"],
  ]);
});
test("same SQL with different binding expressions keeps both source paths", () => {
  const q = extract(
    prelude + 'sql.query("x")`SELECT ${flag ? sql`${first}::int` : sql`${second}::int`}`',
    uri,
  )[0]!;
  const markdown = queryMarkdown(q);
  expect(markdown).toContain("$1 ← first");
  expect(markdown).toContain("$1 ← second");
});
test("preview never executes conditions or interpolations", () => {
  const code =
    prelude +
    'throw new Error("no execution"); sql.query("x")`SELECT ${dangerous()}::int ${sql.where(evil() ? sql`TRUE` : undefined)}`';
  const markdown = queryMarkdown(extract(code, uri)[0]!);
  expect(markdown).toContain("dangerous()");
  expect(markdown).toContain("truthy: evil()");
});
test("preview reports unsupported structure and malformed placeholders", () => {
  const service = new PreviewService();
  const code = prelude + 'sql.query("x")`SELECT 1 ${sql.where(fragmentAlias)}`';
  service.documents.set(uri, code);
  expect(service.hover(uri, position(code, code.indexOf(".query") + 2))!.contents.value).toContain(
    "preview unavailable",
  );
  const bad = prelude + "sql.query(\"x\")`SELECT '${value}'`";
  service.documents.set(uri, bad);
  expect(service.hover(uri, position(bad, bad.indexOf(".query") + 2))!.contents.value).toContain(
    "outside quotes/comments",
  );
});
test("markdown fences cannot be closed by SQL text", () => {
  const q = extract(prelude + 'sql.query("x")`SELECT 1 -- \\`\\`\\` injected`', uri)[0]!;
  expect(queryMarkdown(q)).toContain("````sql");
});
test("UTF-16 offsets round-trip including astral characters and CRLF", () => {
  const text = "// 🦊\r\nconst x = '🌍';\r\n";
  for (let i = 0; i < text.length; i++) expect(offset(text, position(text, i))).toBe(i);
});
test("hover output is bounded and does not silently hide alternatives", () => {
  const code =
    prelude +
    'sql.query("x")`SELECT 1 ${sql.where(a ? sql`a` : undefined,b ? sql`b` : undefined,c ? sql`c` : undefined,d ? sql`d` : undefined)}`';
  const markdown = queryMarkdown(extract(code, uri)[0]!);
  expect(markdown).toContain("showing 8 of 16 paths");
  expect(markdown.length).toBeLessThan(25_000);
});
test("no SQL preview on unrelated code or other libraries", () => {
  const service = new PreviewService();
  service.documents.set(uri, sample);
  expect(service.hover(uri, { line: 0, character: 0 })).toBeNull();
  service.documents.set(uri, sample.replace("../.inline/sql.ts", "other-library"));
  expect(service.hover(uri, { line: 1, character: 3 })).toBeNull();
});

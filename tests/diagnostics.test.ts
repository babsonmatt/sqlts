import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { tooling } from "../src/adapter/reylo.ts";
import { diagnose } from "../src/diagnostics.ts";
import { position, offset } from "../src/preview.ts";
import { extract } from "../src/extract.ts";
import { render } from "../src/parts.ts";

const handlers = tooling.mapperHandlers();
const projectHandle = `diagnostic-test-${crypto.randomUUID()}`;
const file = resolve("examples/diagnostics-test.ts");
const preamble = '// 🌍\nimport { sql } from "../.inline/sql.ts";\n';
beforeAll(() => handlers.openProject({ projectHandle, configFileName: resolve("tsconfig.json") }));
afterAll(async () => {
  await handlers.closeProject({ projectHandle });
  await tooling.releaseConnections();
});

test("unknown column highlights the exact TS token and deduplicates SQL variants", async () => {
  const source =
    preamble +
    'sql.query("x")`SELECT u.id2 FROM reylo_inline_demo.users u ${sql.where(flag ? sql`u.email IS NOT NULL` : undefined)}`';
  const errors = await diagnose(source, file, handlers, projectHandle);
  expect(errors).toHaveLength(1);
  expect(errors[0]!.message).toContain("column u.id2 does not exist");
  expect(errors[0]!.range).toEqual({
    start: position(source, source.indexOf("id2")),
    end: position(source, source.indexOf("id2") + 3),
  });
});
test("nested conditional errors map after parameters, generated grouping and escaped text", async () => {
  const source =
    preamble +
    'sql.query("nested")`SELECT /* 🌍 */ u.id FROM reylo_inline_demo.users u ${sql.where(sql`u.id > ${id}::int`, flag ? sql.or(sql`u.name = ${name}::text`, sql`\\n u.id2 = ${value}::int`) : undefined)}`';
  const errors = await diagnose(source, file, handlers, projectHandle);
  expect(errors).toHaveLength(1);
  const error = errors[0]!;
  expect(source.slice(offset(source, error.range.start), offset(source, error.range.end))).toBe(
    "id2",
  );
});
test("source maps preserve cooked escapes, CRLF and both nested helper branches", () => {
  const source =
    preamble +
    'sql.query("mapped")`SELECT \\u{1F30D} \\x61\\n\r\n ${sql.where(flag ? sql`first` : sql.and(sql`second`, sql`third`))} tail`';
  const q = extract(source, file)[0]!;
  expect(q.variants).toHaveLength(2);
  for (const [i, parts] of q.variants.entries()) {
    const sql = render(parts).named;
    const map = q.sourceMaps[i]!;
    expect(map.length).toBe(sql.length);
    for (const word of ["first", "second", "third", "tail"]) {
      if (sql.includes(word)) expect(map[sql.indexOf(word)]).toBe(source.indexOf(word));
    }
    expect(map[sql.indexOf("🌍")]).toBe(source.indexOf("\\u{"));
    expect(map[sql.indexOf("a")]).toBe(source.indexOf("\\x61"));
  }
});
test("valid correction clears errors without running source or rewriting generated types", async () => {
  const before = await Bun.file(".inline/sql.ts").text();
  const source =
    preamble +
    'throw new Error("application must not execute"); sql.query("good")`SELECT u.id FROM reylo_inline_demo.users u`';
  expect(await diagnose(source, file, handlers, projectHandle)).toEqual([]);
  expect(await Bun.file(".inline/sql.ts").text()).toBe(before);
});

test("escaped identifier diagnostics cover the authored escape", async () => {
  const source = preamble + 'sql.query("escaped")`SELECT id\\u0032 FROM reylo_inline_demo.users`';
  const errors = await diagnose(source, file, handlers, projectHandle);
  expect(errors).toHaveLength(1);
  const range = errors[0]!.range;
  expect(source.slice(offset(source, range.start), offset(source, range.end))).toBe("id\\u0032");
});

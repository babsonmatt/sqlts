import { expect, test } from "bun:test";
import { createSql, type Artifact, type Registry } from "../src/runtime.ts";
import { extract } from "../src/extract.ts";
import { render } from "../src/parts.ts";
import { queryMarkdown } from "../src/preview.ts";

const parsed = (code: string, budget = 64) =>
  extract('import {sql} from "../.inline/sql.ts";\n' + code, "/virtual/short-circuit.ts", budget);
function unchecked(code: string) {
  const artifact: Artifact = Object.create(null);
  for (const q of parsed(code)) {
    artifact[q.id] = Object.create(null);
    for (const parts of q.variants) {
      const { named, values } = render(parts);
      artifact[q.id]![named] = {
        dialect: "postgres",
        sql: named,
        params: values.map((_, i) => `p${i}`),
      };
    }
  }
  return createSql<Registry>(artifact);
}

test("&& agrees with ternaries for optional strings, booleans and numeric guards", () => {
  const code =
    'sql.query("x")`SELECT id FROM users ${sql.where(sql`org_id = ${orgId}`, search && sql`name ILIKE ${search}`, email && sql`email IS NOT NULL`, min != null && sql`age >= ${min}`)} ORDER BY id`';
  const sql = unchecked(code);
  for (const search of [undefined, null, "", "Alice", "' OR TRUE; --"])
    for (const email of [false, true])
      for (const min of [undefined, 0, 18]) {
        const orgId = 10;
        const short = sql.query(
          "x",
        )`SELECT id FROM users ${sql.where(sql`org_id = ${orgId}`, search && sql`name ILIKE ${search}`, email && sql`email IS NOT NULL`, min != null && sql`age >= ${min}`)} ORDER BY id`;
        const ternary = sql.query(
          "x",
        )`SELECT id FROM users ${sql.where(sql`org_id = ${orgId}`, search ? sql`name ILIKE ${search}` : undefined, email ? sql`email IS NOT NULL` : undefined, min != null ? sql`age >= ${min}` : undefined)} ORDER BY id`;
        expect(short.compile()).toEqual(ternary.compile());
        expect(short.compile().values).toEqual([
          10,
          ...(search ? [search] : []),
          ...(min != null ? [min] : []),
        ]);
      }
});

test("all falsy helper operands disappear; SQL parameter values remain untouched", () => {
  const sql = unchecked(
    'sql.query("x")`SELECT ${zero}, ${empty}, ${flag}, ${nil}, ${big} ${sql.where(enabled && sql`TRUE`)}`',
  );
  for (const guard of [false, undefined, null, "", 0, -0, 0n, NaN]) {
    const query = sql.query(
      "x",
    )`SELECT ${0}, ${""}, ${false}, ${null}, ${0n} ${sql.where(guard && sql`TRUE`)}`;
    expect(query.compile()).toEqual({
      text: "SELECT $1, $2, $3, $4, $5 ",
      values: [0, "", false, null, 0n],
    });
  }
  // A truthy nonfragment must still be rejected, including through untyped callers.
  const call = (...v: unknown[]) => (sql.where as (...v: unknown[]) => unknown)(...v);
  for (const bad of [true, 1, "AND TRUE", {}, createSql({})`TRUE`])
    expect(() => call(bad)).toThrow("fragments from this sql instance only");
});

test("nested helpers and chained guards preserve parentheses, bindings and empty identities", () => {
  const code =
    'sql.query("x")`SELECT 1 ${sql.where(a && sql.or(b && sql`id = ${id}`, c ? sql.and(d && sql`name = ${name}`) : sql.empty))}`';
  const sql = unchecked(code);
  for (const a of [false, true])
    for (const b of [false, true])
      for (const c of [false, true])
        for (const d of [false, true]) {
          const id = 4,
            name = "Alice";
          const query = sql.query(
            "x",
          )`SELECT 1 ${sql.where(a && sql.or(b && sql`id = ${id}`, c ? sql.and(d && sql`name = ${name}`) : sql.empty))}`;
          expect(query.compile().values).toEqual(
            a ? [...(b ? [4] : []), ...(c && d ? [name] : [])] : [],
          );
          if (!a) expect(query.compile().text).toBe("SELECT 1 ");
          if (a && !b && !c) expect(query.compile().text).toBe("SELECT 1 WHERE (FALSE)");
          if (a && !b && c && !d) expect(query.compile().text).toBe("SELECT 1 WHERE (((TRUE)))");
        }
  const q = parsed('sql.query("x")`SELECT 1 ${sql.where(a && b && sql`id = ${id}`)}`')[0]!;
  expect(q.alternatives.map((v) => v.conditions)).toEqual([["truthy: a && b"], ["falsy: a && b"]]);
});

test("analysis and previews enumerate && without executing guards and preserve SQL source locations", () => {
  const code =
    'sql.query("x")`SELECT 1 ${sql.where(explode() && (other() ? sql`id = ${id}` : sql`name = ${name}`))}`';
  const q = parsed(code)[0]!;
  expect(q.alternatives.map((v) => v.conditions)).toEqual([
    ["truthy: explode()", "truthy: other()"],
    ["truthy: explode()", "falsy: other()"],
    ["falsy: explode()"],
  ]);
  const markdown = queryMarkdown(q);
  expect(markdown).toContain("3 possible source path(s)");
  expect(markdown).toContain("truthy: explode()");
  expect(markdown).toContain("WHERE (id = $1)");
  expect(markdown).toContain("$1 ← name");
  const source = 'import {sql} from "../.inline/sql.ts";\n' + code;
  const named = render(q.variants[1]!).named;
  expect(q.sourceMaps[1]![named.indexOf("name")]).toBe(source.indexOf("name ="));
  expect(() =>
    parsed('sql.query("x")`SELECT 1 ${sql.where(a && sql`a`, b && sql`b`)}`', 2),
  ).toThrow("More than 2");
});

test("ordinary && interpolations stay parameters; conditional fragments require a helper", () => {
  const q = parsed('sql.query("x")`SELECT ${flag && value}::boolean`')[0]!;
  expect(q.variants).toHaveLength(1);
  expect(render(q.variants[0]!).named).toBe("SELECT :p0::boolean");
  for (const expression of ["flag && sql`AND TRUE`", "other ? flag && sql`AND TRUE` : sql.empty"])
    expect(() => parsed('sql.query("x")`SELECT 1 ${' + expression + "}`")).toThrow(
      "inside sql.where",
    );
  expect(() => parsed('sql.query("x")`SELECT 1 ${sql.where(flag && fragmentAlias)}`')).toThrow(
    "fragment aliases",
  );
  const absent = parsed(
    'sql.query("x")`SELECT 1 ${sql.where("", 0, -0, 0n, false, null, undefined, sql.empty)}`',
  )[0]!;
  expect(render(absent.variants[0]!).named).toBe("SELECT 1 ");
});

// Checked by Bun/TypeScript: skipping falsy values must not erase present input types.
export function shortCircuitTypeContracts(
  search: string | undefined,
  enabled: boolean,
  n: number,
  big: bigint,
) {
  const sql = createSql<{
    x: { inputs: readonly [number] | readonly [number, string]; row: { id: number } };
  }>({});
  const valid = sql.query(
    "x",
  )`SELECT id FROM users ${sql.where(sql`id = ${n}`, search && sql`name = ${search}`)}`;
  sql.where(n && sql`TRUE`, big && sql`TRUE`, enabled && sql`TRUE`);
  const required = sql`id = ${n}`;
  const wrong = enabled && sql`name = ${123}`;
  // @ts-expect-error The optional predicate still requires a string input.
  const invalid = sql.query("x")`${sql.where(required, wrong)}`;
  // @ts-expect-error Truthy strings are not fragments.
  sql.where("name = 'Alice'");
  // @ts-expect-error Truthy numbers are not fragments.
  sql.where(42);
  return { valid, invalid };
}

import { describe, expect, test } from "bun:test";
import { createSql, type Artifact, type Registry } from "../src/runtime.ts";
import { extract } from "../src/extract.ts";
import { render } from "../src/parts.ts";
import { validatePlaceholders } from "../src/validate.ts";
import { searchUsers, allUsers } from "../examples/queries.ts";

const prefix = 'import { sql } from "../.inline/sql.ts";\n';
const parsed = (code: string, budget?: number) =>
  extract(prefix + code, "/virtual/queries.ts", budget);
function unchecked(code: string) {
  const artifact: Artifact = Object.create(null);
  for (const q of parsed(code)) {
    artifact[q.id] = Object.create(null);
    for (const p of q.variants) {
      const { named, values } = render(p);
      artifact[q.id]![named] = {
        dialect: "postgres",
        sql: named,
        params: values.map((_, i) => `p${i}`),
      };
    }
  }
  return createSql<Registry>(artifact);
}

describe("composition and binding", () => {
  test("optional WHERE disappears and following ORDER BY stays valid", () => {
    expect(allUsers(false).compile().text).not.toContain("WHERE");
    expect(allUsers(true).compile().text).toContain("WHERE (email IS NOT NULL)");
  });
  test("all predicates present have ordered bindings and grouped OR", () => {
    const q = searchUsers(10, "Alice", true, 5).compile();
    expect(q.values).toEqual([10, "%Alice%", "%Alice%", 5]);
    expect(q.text).toContain(
      "WHERE (u.org_id = $1) AND (((u.name ILIKE $2) OR (u.email ILIKE $3))) AND (u.email IS NOT NULL)",
    );
  });
  test("SQL-looking strings stay parameters", () => {
    const attack = "' OR TRUE; DROP TABLE users; --";
    const q = searchUsers(10, attack, false).compile();
    expect(q.text).not.toContain(attack);
    expect(q.values[1]).toBe(`%${attack}%`);
  });
  test("compile returns independent values", () => {
    const query = searchUsers(10, "Alice", true);
    query.compile().values[0] = 900;
    expect(query.compile().values[0]).toBe(10);
  });
  test("mutable bound values are captured when fragments are created", () => {
    const sql = unchecked('sql.query("x")`SELECT ${sql` ${payload}::jsonb`}`');
    const payload = { a: [1] };
    const part = sql` ${payload}::jsonb`;
    payload.a.push(2);
    const query = sql.query("x")`SELECT ${part}`;
    const first = query.compile();
    (first.values[0] as { a: number[] }).a.push(3);
    expect(query.compile().values).toEqual([{ a: [1] }]);
  });
  test("stale SQL and unknown IDs fail before execution", () => {
    const sql = unchecked('sql.query("x")`SELECT ${value}::int`');
    expect(() => sql.query("x")`SELECT ${1}::text`).toThrow("stale SQL shape");
    expect(() => sql.query("other")`SELECT ${1}::int`).toThrow("Unknown");
  });
  test("empty boolean groups have explicit identities", () => {
    const sql = unchecked('sql.query("x")`SELECT ${sql.and()}, ${sql.or()}, ${sql.where()}`');
    expect(sql.query("x")`SELECT ${sql.and()}, ${sql.or()}, ${sql.where()}`.compile().text).toBe(
      "SELECT TRUE, FALSE, ",
    );
  });
});

describe("static extraction", () => {
  test("nested conditionals enumerate branches without running conditions", () => {
    const q = parsed(
      'sql.query("x")`SELECT 1 ${sql.where(flag() ? (other() ? sql`a = ${one}` : sql`b = ${two}`) : undefined)}`',
    )[0]!;
    expect(q.variants.map((v) => render(v).named)).toEqual([
      "SELECT 1 WHERE (a = :p0)",
      "SELECT 1 WHERE (b = :p0)",
      "SELECT 1 ",
    ]);
  });
  test("value ternaries stay single parameters", () => {
    expect(parsed('sql.query("x")`SELECT ${flag ? 1 : 2}::int`')[0]!.variants).toHaveLength(1);
  });
  test("aliases of the imported tag work but shadowed imports do not", () => {
    expect(
      extract(
        'import { sql as q } from "../.inline/sql.ts"; q.query("x")`SELECT 1`',
        "/virtual/a.ts",
      ),
    ).toHaveLength(1);
    expect(parsed('function f(sql: any) { return sql.query("x")`SELECT 1`; }')).toHaveLength(0);
  });
  test("fragment aliases and unrecognized helpers in clauses fail clearly", () => {
    expect(() => parsed('sql.query("x")`SELECT 1 ${sql.where(myFragment)}`')).toThrow(
      "fragment aliases",
    );
    expect(() => parsed('sql.query("x")`SELECT 1 ${sql.where(helper())}`')).toThrow(
      "arbitrary helper",
    );
  });
  test("shape budget bounds combinatorial growth", () => {
    expect(() =>
      parsed(
        'sql.query("x")`SELECT 1 ${sql.where(a ? sql`x` : undefined, b ? sql`y` : undefined)}`',
        2,
      ),
    ).toThrow("More than 2");
  });
  test("literal query IDs are required", () => {
    expect(() => parsed("sql.query(name)`SELECT 1`")).toThrow("literal query ID");
  });
  test.each([
    "sql.query(\"x\")`SELECT '${value}'`",
    'sql.query("x")`SELECT 1 /* ${value} */`',
    'sql.query("x")`SELECT $$ ${value} $$`',
    'sql.query("x")`SELECT :p0, ${value}`',
    'sql.query("x")`SELECT $1, ${value}`',
    'sql.query("x")`SELECT :p0 /* ${value} */`',
  ])("rejects hidden or authored placeholders: %s", (code) => {
    expect(() => validatePlaceholders(parsed(code)[0]!.variants[0]!)).toThrow(
      "Interpolations must be SQL values",
    );
  });
  test("placeholder-like quoted literals are harmless", () => {
    validatePlaceholders(
      parsed("sql.query(\"x\")`SELECT '$1 :p0', ${value}::int`")[0]!.variants[0]!,
    );
  });
});

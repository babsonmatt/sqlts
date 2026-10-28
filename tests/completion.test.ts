import { expect, test } from "bun:test";
import { CompletionService } from "../src/completion.ts";
import { position, offset } from "../src/preview.ts";
import type { Catalog } from "../src/catalog.ts";
const catalog: Catalog = {
  schemas: ["public", "demo"],
  keywords: ["order", "select", "user"],
  relations: [
    {
      schema: "public",
      name: "users",
      visible: true,
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "name", type: "text", nullable: false },
        { name: "email", type: "text", nullable: true },
        { name: "Order", type: "text", nullable: true },
      ],
    },
    {
      schema: "demo",
      name: "orders",
      visible: false,
      columns: [
        { name: "id", type: "integer", nullable: false },
        { name: "total", type: "bigint", nullable: false },
      ],
    },
  ],
};
const service = new CompletionService();
function complete(sql: string, schema = catalog) {
  const marked =
    '// 🌍\nimport { sql } from "../.inline/sql.ts";\nconst q = sql.query("x")`' + sql + "`;";
  const cursor = marked.indexOf("▌");
  const source = marked.replace("▌", "");
  const result = service.complete(source, "/test.ts", position(source, cursor), schema);
  return { source, cursor, result, labels: result.items.map((i) => i.label) };
}
test("alias columns can be completed before FROM, with type metadata", () => {
  const { result, labels } = complete("SELECT u.▌ FROM users u");
  expect(labels).toContain("email");
  expect(result.items.find((i) => i.label === "email")!.filterText).toBe("u.email");
  expect(result.items.find((i) => i.label === "email")!.detail).toContain("text · table nullable");
});
test("table and schema completions quote/qualify names and replace partial words", () => {
  expect(complete("SELECT * FROM ▌").labels).toEqual(["public", "demo", "users", "demo.orders"]);
  const { source, result } = complete("SELECT * FROM demo.or▌ders");
  expect(result.items).toHaveLength(1);
  const edit = result.items[0]!.textEdit;
  expect(source.slice(offset(source, edit.range.start), offset(source, edit.range.end))).toBe(
    "orders",
  );
  expect(edit.newText).toBe("orders");
});
test("column edits replace the suffix too and safely quote identifiers", () => {
  const { source, result } = complete("SELECT u.na▌me FROM users u");
  const edit = result.items[0]!.textEdit;
  expect(source.slice(offset(source, edit.range.start), offset(source, edit.range.end))).toBe(
    "name",
  );
  expect(complete("SELECT u.Ord▌ FROM users u").result.items[0]!.textEdit.newText).toBe('"Order"');
});
test("joins disambiguate shared column names and respect explicit aliases", () => {
  expect(complete("SELECT i▌ FROM users u JOIN demo.orders o ON u.id = o.id").labels).toEqual([
    "u.id",
    "o.id",
  ]);
  expect(complete("SELECT o.▌ FROM users u JOIN demo.orders o ON u.id = o.id").labels).toEqual([
    "id",
    "total",
  ]);
  expect(complete("SELECT users.▌ FROM users u").labels).toEqual([]);
});
test("inner SELECT does not borrow outer aliases, and UNION scopes do not leak", () => {
  expect(complete("SELECT (SELECT o.▌ FROM demo.orders o) FROM users u").labels).toEqual([
    "id",
    "total",
  ]);
  expect(complete("SELECT o.▌, (SELECT id FROM demo.orders o) FROM users u").labels).toEqual([]);
  expect(complete("SELECT id FROM users u UNION SELECT o.▌ FROM demo.orders o").labels).toEqual([
    "id",
    "total",
  ]);
});
test("SQL comments, strings and JavaScript interpolations do not get SQL items", () => {
  for (const sql of [
    "SELECT 'u.▌' FROM users u",
    "SELECT 1 /* u.▌ */ FROM users u",
    "SELECT $$u.▌$$ FROM users u",
    "SELECT ${u.▌id} FROM users u",
  ])
    expect(complete(sql).labels).toEqual([]);
});
test("nested conditional fragments retain completion context", () => {
  expect(
    complete("SELECT u.id FROM users u ${sql.where(flag ? sql`u.▌` : undefined)}").labels,
  ).toContain("email");
  const { result } = complete(
    "SELECT o.▌ FROM users u ${flag ? sql`JOIN demo.orders o ON o.id = u.id` : sql.empty}",
  );
  expect(result.items[0]!.detail).toContain("available in 1/2 SQL alternatives");
});
test("CTE names and derived aliases do not masquerade as catalog tables", () => {
  expect(complete("WITH users AS (SELECT 1 AS n) SELECT u.▌ FROM users u").labels).toEqual(["n"]);
  expect(complete("SELECT u.▌ FROM (SELECT 1 AS n) u").labels).toEqual(["n"]);
});
test("unrelated tags and shadowed imports do not get SQL completions", () => {
  const source = 'import {sql} from "other"; sql.query("x")`SELECT u. FROM users u`';
  expect(
    service.complete(source, "/other.ts", position(source, source.indexOf("u.") + 2), catalog)
      .items,
  ).toEqual([]);
});

const advanced: Catalog = {
  ...catalog,
  functions: [
    {
      schema: "pg_catalog",
      name: "lower",
      visible: true,
      arguments: "text",
      inputTypes: ["text"],
      result: "text",
      setReturning: false,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "lower",
      visible: true,
      arguments: "anyrange",
      inputTypes: ["anyrange"],
      result: "anyelement",
      setReturning: false,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "sum",
      visible: true,
      arguments: "integer",
      inputTypes: ["integer"],
      result: "bigint",
      setReturning: false,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "jsonb_each",
      visible: true,
      arguments: "jsonb, OUT key text, OUT value jsonb",
      inputTypes: ["jsonb"],
      result: "SETOF record",
      setReturning: true,
      columns: [
        { name: "key", type: "text", nullable: null },
        { name: "value", type: "jsonb", nullable: null },
      ],
    },
    {
      schema: "demo",
      name: "greet",
      visible: false,
      arguments: "name text, times integer DEFAULT 1",
      inputTypes: ["text", "integer"],
      result: "text",
      setReturning: false,
      columns: [],
    },
  ],
};
test("CTE projections expose aliases and aggregate output, not underlying table columns", () => {
  const r = complete(
    "WITH spending AS (SELECT id, sum(id) AS total FROM users GROUP BY id) SELECT s.▌ FROM spending s",
    advanced,
  );
  expect(r.labels).toEqual(["id", "total"]);
  expect(r.result.items.find((i) => i.label === "total")!.detail).toContain("bigint");
  expect(r.result.items[0]!.detail).toContain("nullability not inferred");
});
test("chained CTEs, explicit output lists, materialization and quoted aliases", () => {
  expect(
    complete(
      'WITH a(x,y) AS MATERIALIZED (SELECT id,name FROM users), b AS NOT MATERIALIZED (SELECT x AS "UserId" FROM a) SELECT b.▌ FROM b',
    ).labels,
  ).toEqual(["UserId"]);
  expect(
    complete("SELECT s.▌ FROM (SELECT id,name FROM users) AS s(uid,display_name)").labels,
  ).toEqual(["uid", "display_name"]);
});
test("projected wildcards, implicit aliases and nested derived results", () => {
  expect(complete("SELECT s.▌ FROM (SELECT id, name display_name FROM users) s").labels).toEqual([
    "id",
    "display_name",
  ]);
  expect(
    complete(
      "WITH a AS (SELECT u.* FROM users u) SELECT x.▌ FROM (SELECT a.name AS display FROM a) x",
    ).labels,
  ).toEqual(["display"]);
});
test("recursive CTEs are bounded and expose declared output names", () => {
  expect(
    complete(
      "WITH RECURSIVE walk(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM walk WHERE n<4) SELECT w.▌ FROM walk w",
    ).labels,
  ).toEqual(["n"]);
  expect(
    complete(
      "WITH RECURSIVE walk(n) AS (VALUES (1) UNION ALL SELECT w.▌ FROM walk w) SELECT * FROM walk",
    ).labels,
  ).toEqual(["n"]);
});
test("CTE scope does not leak forward or into sibling scopes", () => {
  expect(
    complete("WITH a AS (SELECT b.▌ FROM b), b AS (SELECT id FROM users) SELECT * FROM a").labels,
  ).toEqual([]);
  expect(
    complete("SELECT (WITH a AS (SELECT id FROM users) SELECT id FROM a), (SELECT a.▌ FROM a)")
      .labels,
  ).toEqual([]);
});
test("correlated and lateral subqueries see permitted outer aliases only", () => {
  expect(complete("SELECT u.id FROM users u WHERE EXISTS (SELECT u.▌)").labels).toContain("email");
  expect(complete("SELECT * FROM users u JOIN LATERAL (SELECT u.▌) x ON true").labels).toContain(
    "email",
  );
  expect(complete("SELECT * FROM users u JOIN (SELECT u.▌) x ON true").labels).toEqual([]);
  expect(
    complete("SELECT * FROM users u WHERE EXISTS (SELECT u.▌ FROM demo.orders u)").labels,
  ).toEqual(["id", "total"]);
});
test("data-modifying CTEs project RETURNING", () => {
  expect(
    complete(
      "WITH changed AS (UPDATE users SET name='x' RETURNING id,name AS updated_name) SELECT c.▌ FROM changed c",
    ).labels,
  ).toEqual(["id", "updated_name"]);
});
test("UPDATE SET LHS uses target columns and RHS can see FROM bindings", () => {
  expect(complete("UPDATE users u SET na▌ FROM demo.orders o").labels).toEqual(["name"]);
  expect(complete("UPDATE users u SET name=o.▌ FROM demo.orders o WHERE o.id=u.id").labels).toEqual(
    ["id", "total"],
  );
  expect(complete("UPDATE users SET name='x', em▌").labels).toEqual(["email"]);
  expect(complete("UPDATE users u SET u.▌").labels).toEqual([]);
});
test("INSERT columns, conflict targets, EXCLUDED and RETURNING have distinct scopes", () => {
  expect(complete("INSERT INTO users (na▌) VALUES ($1)").labels).toEqual(["name"]);
  expect(
    complete("INSERT INTO users (name) VALUES ($1) ON CONFLICT (i▌) DO NOTHING").labels,
  ).toEqual(["id"]);
  expect(
    complete("INSERT INTO users(name) VALUES ($1) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.na▌")
      .labels,
  ).toEqual(["name"]);
  expect(complete("INSERT INTO users(name) VALUES (EXCLUDED.na▌)").labels).toEqual([]);
  expect(
    complete(
      "INSERT INTO users(name) VALUES ($1) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name RETURNING EXCLUDED.▌",
    ).labels,
  ).toEqual([]);
  expect(complete("INSERT INTO users AS u(name) VALUES ($1) RETURNING u.▌").labels).toContain(
    "email",
  );
});
test("INSERT SELECT has its own sources and DELETE USING exposes joined rows", () => {
  expect(complete("INSERT INTO users(id) SELECT o.▌ FROM demo.orders o").labels).toEqual([
    "id",
    "total",
  ]);
  expect(complete("INSERT INTO users(id) SELECT users.▌ FROM demo.orders o").labels).toEqual([]);
  expect(
    complete("DELETE FROM users u USING demo.orders o WHERE u.id=o.id RETURNING u.▌").labels,
  ).toContain("email");
  expect(complete("DELETE FROM users USING demo.or▌").labels).toEqual(["orders"]);
});
test("write targets suggest tables", () => {
  expect(complete("UPDATE us▌ SET name=$1").labels).toEqual(["users"]);
  expect(complete("INSERT INTO us▌").labels).toEqual(["users"]);
  expect(complete("DELETE FROM us▌").labels).toEqual(["users"]);
});
test("function names, overload signatures, schema qualification and output columns", () => {
  const lower = complete("SELECT low▌ FROM users", advanced);
  expect(lower.labels).toEqual(["lower"]);
  expect(lower.result.items[0]!.detail).toContain("lower(text)");
  expect(lower.result.items[0]!.detail).toContain("lower(anyrange)");
  expect(complete("SELECT demo.gr▌ FROM users", advanced).labels).toEqual(["greet"]);
  expect(complete("SELECT item.▌ FROM jsonb_each($1::jsonb) AS item", advanced).labels).toEqual([
    "key",
    "value",
  ]);
  expect(
    complete("SELECT item.▌ FROM jsonb_each($1::jsonb) WITH ORDINALITY AS item(k,v,ord)", advanced)
      .labels,
  ).toEqual(["k", "v", "ord"]);
});
test("signature help understands nested calls, commas and SQL literal arguments", () => {
  const { source, cursor } = complete("SELECT demo.greet(lower(name), ▌) FROM users", advanced);
  const help = service.signatureHelp(source, "/test.ts", position(source, cursor), advanced);
  expect(help?.activeParameter).toBe(1);
  expect(help?.signatures[0]!.label).toContain("demo.greet(");
  const nested = complete("SELECT lower(▌name) FROM users", advanced);
  expect(
    service.signatureHelp(
      nested.source,
      "/test.ts",
      position(nested.source, nested.cursor),
      advanced,
    )?.signatures,
  ).toHaveLength(2);
});

test("VALUES expressions offer functions without leaking target columns", () => {
  expect(complete("INSERT INTO users(name) VALUES (low▌)", advanced).labels).toEqual(["lower"]);
  expect(complete("INSERT INTO users(name) VALUES (us▌)", advanced).labels).toEqual([]);
});
test("scalar table-function aliases rename the output column", () => {
  expect(complete("SELECT f.▌ FROM lower($1::text) AS f", advanced).labels).toEqual(["f"]);
});

test("cast and schema-qualified function projections retain their output names", () => {
  expect(
    complete(
      "SELECT s.▌ FROM (SELECT u.id::text, pg_catalog.lower(u.name) FROM users u) s",
      advanced,
    ).labels,
  ).toEqual(["id", "lower"]);
});
test("SQL function hover exposes overloads without depending on signature popup routing", () => {
  const { source, cursor } = complete("SELECT low▌er(name) FROM users", advanced);
  const hover = service.functionHover(source, "/test.ts", position(source, cursor), advanced);
  expect(hover?.contents.value).toContain("pg_catalog.lower(text)");
  expect(hover?.contents.value).toContain("pg_catalog.lower(anyrange)");
});

test("editing incomplete predicates, calls, CTEs and quoted prefixes keeps local scope", () => {
  for (const sql of [
    "SELECT * FROM users u WHERE (u.▌",
    "SELECT * FROM users u WHERE lower(u.na▌",
    "WITH a AS (SELECT * FROM users u WHERE u.▌",
    'SELECT * FROM users u WHERE u."na▌',
    "SELECT * FROM users u WHERE EXISTS (SELECT 1 WHERE u.▌",
  ])
    expect(complete(sql, advanced).labels).toContain(sql.includes("na▌") ? "name" : "id");
});
test("SQL completion survives unfinished TS elsewhere and an unterminated template", () => {
  const prefix = 'import { sql } from "../.inline/sql.ts";\n';
  for (const text of [
    prefix + 'const broken = ; sql.query("x")`SELECT * FROM users u WHERE u.',
    prefix +
      'sql.query("bad")`${sql.where(unknownHelper())}`; sql.query("x")`SELECT * FROM users u WHERE u.',
  ]) {
    expect(
      service
        .complete(text, "/incomplete.ts", position(text, text.length), catalog)
        .items.map((i) => i.label),
    ).toContain("email");
  }
});
test("nested scalar subqueries inside function calls correlate without leaking forward JOINs", () => {
  expect(complete("SELECT coalesce((SELECT u.▌), 1) FROM users u").labels).toContain("email");
  expect(
    complete("SELECT * FROM users u JOIN demo.orders o ON later.▌=o.id JOIN users later ON true")
      .labels,
  ).toEqual([]);
});
test("nested recursive CTE, UNION, lateral output and conditional predicates compose", () => {
  const sql =
    "WITH RECURSIVE walk(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM walk WHERE n<3), names AS (SELECT id, name AS label FROM users) SELECT result.▌ FROM names n JOIN LATERAL (SELECT n.label, w.n AS step FROM walk w UNION ALL SELECT n.label, 0) result ON true ${sql.where(flag ? sql`n.id > ${id}` : undefined)}";
  expect(complete(sql).labels).toEqual(["label", "step"]);
});
test("MERGE scopes distinguish target, source, SET columns, INSERT columns and RETURNING", () => {
  const merge = "MERGE INTO users u USING demo.orders o ON u.id=o.id ";
  expect(complete("MERGE INTO us▌").labels).toEqual(["users"]);
  expect(complete("MERGE INTO users USING demo.or▌").labels).toEqual(["orders"]);
  expect(complete(merge + "WHEN MATCHED THEN UPDATE SET na▌").labels).toEqual(["name"]);
  expect(complete(merge + "WHEN MATCHED THEN UPDATE SET name=o.▌").labels).toEqual(["id", "total"]);
  expect(complete(merge + "WHEN NOT MATCHED THEN INSERT (na▌) VALUES(o.id)").labels).toEqual([
    "name",
  ]);
  expect(complete(merge + "WHEN NOT MATCHED AND u.▌ THEN DO NOTHING").labels).toEqual([]);
  expect(complete(merge + "WHEN NOT MATCHED THEN INSERT(id) VALUES(o.▌)").labels).toEqual([
    "id",
    "total",
  ]);
  expect(complete(merge + "WHEN NOT MATCHED BY SOURCE AND o.▌ THEN DELETE").labels).toEqual([]);
  expect(complete(merge + "WHEN NOT MATCHED BY SOURCE AND u.▌ THEN DELETE").labels).toContain(
    "email",
  );
  expect(complete(merge + "WHEN MATCHED THEN DELETE RETURNING u.▌").labels).toContain("email");
});
const polymorphic: Catalog = {
  ...advanced,
  types: [
    { name: "integer[]", element: "integer" },
    { name: "int4range", rangeSubtype: "integer" },
    { name: "int4multirange", multirangeRange: "int4range" },
  ],
  functions: [
    ...advanced.functions!,
    {
      schema: "pg_catalog",
      name: "unnest",
      visible: true,
      arguments: "anyarray",
      inputTypes: ["anyarray"],
      result: "SETOF anyelement",
      setReturning: true,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "jsonb_to_record",
      visible: true,
      arguments: "jsonb",
      inputTypes: ["jsonb"],
      result: "record",
      setReturning: false,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "jsonb_populate_record",
      visible: true,
      arguments: "anyelement, jsonb",
      inputTypes: ["anyelement", "jsonb"],
      result: "anyelement",
      setReturning: false,
      columns: [],
    },
    {
      schema: "pg_catalog",
      name: "array_append",
      visible: true,
      arguments: "anycompatiblearray, anycompatible",
      inputTypes: ["anycompatiblearray", "anycompatible"],
      result: "anycompatiblearray",
      setReturning: false,
      columns: [],
    },
  ],
};
test("polymorphic array/range functions resolve only provable output types", () => {
  expect(
    complete("SELECT x.▌ FROM unnest($1::int[]) x", polymorphic).result.items[0]!.detail,
  ).toContain("integer ·");
  expect(
    complete("SELECT s.▌ FROM (SELECT lower($1::int4range) AS edge) s", polymorphic).result
      .items[0]!.detail,
  ).toContain("integer ·");
  expect(
    complete("SELECT s.▌ FROM (SELECT array_append($1::int[], $2::integer) AS a) s", polymorphic)
      .result.items[0]!.detail,
  ).toContain("integer[] ·");
  expect(
    complete("SELECT s.▌ FROM (SELECT array_append($1::int[], $2::bigint) AS a) s", polymorphic)
      .result.items[0]!.detail,
  ).toContain("SQL expression");
  expect(
    complete("SELECT s.▌ FROM (SELECT lower($1) AS edge) s", polymorphic).result.items[0]!.detail,
  ).toContain("SQL expression");
});
test("anonymous records use SQL column definitions; composite polymorphic outputs use catalog", () => {
  const r = complete(
    'SELECT r.▌ FROM jsonb_to_record($1::jsonb) AS r("UserId" int, display_name text)',
    polymorphic,
  );
  expect(r.labels).toEqual(["UserId", "display_name"]);
  expect(r.result.items[0]!.detail).toContain("integer ·");
  expect(complete("SELECT r.▌ FROM jsonb_to_record($1::jsonb) r", polymorphic).labels).toEqual([]);
  expect(
    complete("SELECT r.▌ FROM jsonb_populate_record(NULL::users, $1::jsonb) r", polymorphic).labels,
  ).toContain("email");
});

test("set-operation output names come from the first arm and differing types stay conservative", () => {
  const sql =
    "SELECT x.▌ FROM (SELECT id AS value FROM users UNION ALL SELECT total FROM demo.orders) x";
  const result = complete(sql);
  expect(result.labels).toEqual(["value"]);
  expect(result.result.items[0]!.detail).toContain("SQL expression");
  expect(
    complete("SELECT id AS uid FROM users u UNION ALL SELECT id FROM demo.orders o ORDER BY ui▌")
      .labels,
  ).toEqual(["uid"]);
  expect(
    complete("SELECT id FROM users u UNION ALL SELECT id FROM demo.orders o ORDER BY o.▌").labels,
  ).toEqual([]);
});

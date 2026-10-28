import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { createSql, type Artifact, type Registry } from "../src/runtime.ts";
import type { QueryDefinition } from "reylo";

const named = "SELECT :p0 AS value";
function definition(sql = named): QueryDefinition {
  return {
    dialect: "postgres",
    sql,
    params: ["p0"],
    fresh: {
      query: "CHECK TEST SCHEMA",
      rows: [["items", "value", "integer", "true", "false"]],
      inserts: [],
    },
  };
}
function driver() {
  const calls: { text: string; values: unknown[] }[] = [];
  let type = "integer";
  return {
    calls,
    setType(value: string) {
      type = value;
    },
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values: structuredClone(values) });
      await Promise.resolve();
      return {
        rows:
          text === "CHECK TEST SCHEMA"
            ? [["items", "value", type, "true", "false"]]
            : [{ value: values[0] }],
      };
    },
  };
}

test("rebuilding one SQL shape reuses Reylo freshness but keeps new bindings", async () => {
  const sql = createSql<Registry>({ x: { [named]: definition() } });
  const db = driver();
  for (const value of [1, 2, 3])
    expect(await sql.query("x")`SELECT ${value} AS value`.run(db)).toEqual([{ value }]);
  expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(1);
  expect(db.calls.filter((c) => c.text !== "CHECK TEST SCHEMA").map((c) => c.values)).toEqual([
    [1],
    [2],
    [3],
  ]);
  expect(() => sql.query("x")`SELECT ${1} AS wrong`).toThrow("stale SQL shape");
});

test("cached executables still recheck after Reylo's interval and reject changed schemas", async () => {
  const now = spyOn(performance, "now").mockReturnValue(1000);
  try {
    const sql = createSql<Registry>({ x: { [named]: definition() } });
    const db = driver();
    await sql.query("x")`SELECT ${1} AS value`.run(db);
    now.mockReturnValue(60_999);
    await sql.query("x")`SELECT ${2} AS value`.run(db);
    expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(1);
    now.mockReturnValue(61_001);
    db.setType("text");
    await rejects(sql.query("x")`SELECT ${3} AS value`.run(db), /database changed/);
    expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(2);
    expect(db.calls.filter((c) => c.text !== "CHECK TEST SCHEMA")).toHaveLength(2);
    db.setType("integer");
    expect(await sql.query("x")`SELECT ${4} AS value`.run(db)).toEqual([{ value: 4 }]);
    await sql.query("x")`SELECT ${5} AS value`.run(db);
    expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(3);
  } finally {
    now.mockRestore();
  }
});

test("query IDs, SQL variants, sql instances, and replaced metadata have independent executables", async () => {
  const variant = "SELECT :p0 AS value WHERE TRUE";
  const artifact: Artifact = {
    x: { [named]: definition(), [variant]: definition(variant) },
    y: { [named]: definition() },
  };
  const sql = createSql<Registry>(artifact),
    other = createSql<Registry>(artifact),
    db = driver();
  await sql.query("x")`SELECT ${1} AS value`.run(db);
  await sql.query("x")`SELECT ${2} AS value WHERE TRUE`.run(db);
  await sql.query("y")`SELECT ${3} AS value`.run(db);
  await other.query("x")`SELECT ${4} AS value`.run(db);
  expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(4);
  artifact.x![named] = definition();
  await sql.query("x")`SELECT ${5} AS value`.run(db);
  await sql.query("x")`SELECT ${6} AS value`.run(db);
  expect(db.calls.filter((c) => c.text === "CHECK TEST SCHEMA")).toHaveLength(5);
});

test("concurrent queries share no parameter values or clients, including mutable inputs", async () => {
  const sql = createSql<Registry>({ x: { [named]: definition() } });
  const warm = driver();
  await sql.query("x")`SELECT ${0} AS value`.run(warm);
  function client(label: string) {
    return {
      async query(_text: string, values: unknown[] = []) {
        await Promise.resolve();
        const value = values[0] as { id: number };
        const id = value.id;
        value.id = -1; // A driver must not mutate a query or another request's snapshot.
        return { rows: [{ id, client: label }] };
      },
    };
  }
  const a = client("a"),
    b = client("b");
  const queries = Array.from({ length: 32 }, (_, id) => {
    const input = { id };
    const q = sql.query("x")`SELECT ${input} AS value`;
    input.id = -2;
    return q;
  });
  const rows = await Promise.all(queries.map((q, id) => q.run(id % 2 ? a : b)));
  expect(rows).toEqual(queries.map((_, id) => [{ id, client: id % 2 ? "a" : "b" }]));
  expect(await queries[0]!.run(a)).toEqual([{ id: 0, client: "a" }]);
  expect(queries.map((q) => q.compile().values)).toEqual(queries.map((_, id) => [{ id }]));
});

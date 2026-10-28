import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { PostgresClient } from "reylo";
import { captureExecution, readExecutionMetadata } from "../src/execution-metadata.ts";
import { createSql, type Registry } from "../src/runtime.ts";

test("metadata distinguishes written rows, returned rows, missing counts, and unsafe numbers", () => {
  expect(readExecutionMetadata({ command: "UPDATE", rowCount: 7, rows: [] })).toEqual({
    command: "UPDATE",
    affectedRows: 7,
  });
  expect(readExecutionMetadata({ command: "UPDATE", count: 0, affectedRows: 10 })).toEqual({
    command: "UPDATE",
    affectedRows: 0,
  });
  expect(readExecutionMetadata({ command: "SELECT", rowCount: 9 })).toEqual({
    command: "SELECT",
    affectedRows: 0,
  });
  expect(readExecutionMetadata({ affectedRows: 3 })).toEqual({ command: null, affectedRows: 3 });
  expect(readExecutionMetadata([{ id: 1 }])).toEqual({ command: null, affectedRows: null });
  expect(
    readExecutionMetadata({ command: "DELETE", rowCount: Number.MAX_SAFE_INTEGER + 1 })
      .affectedRows,
  ).toBeNull();
});

test("missing metadata does not retry a successful write", async () => {
  const text = "DELETE FROM items";
  const sql = createSql<Registry>({
    x: { [text]: { dialect: "postgres", sql: text, params: [] } },
  });
  let calls = 0;
  const db = {
    async query() {
      calls++;
      return { rows: [] };
    },
  };
  expect(await sql.query("x")`DELETE FROM items`.runWithMetadata(db)).toEqual({
    rows: [],
    affectedRows: null,
    command: null,
  });
  expect(calls).toBe(1);
  expect(readExecutionMetadata({ command: "TRUNCATE", rowCount: null }).affectedRows).toBeNull();
  expect(readExecutionMetadata({ command: "COPY", rowCount: 12 }).affectedRows).toBeNull();
});

test("capture is per invocation, keeps frozen clients intact and ignores freshness/catalog results", async () => {
  let calls = 0;
  const client = Object.freeze({
    async query(sql: string) {
      expect(this).toBe(client);
      calls++;
      await Promise.resolve();
      return {
        rows: [],
        rowCount: sql === "UPDATE first" ? 2 : 5,
        command: sql.startsWith("UPDATE") ? "UPDATE" : "SELECT",
      };
    },
  });
  const run = (sql: string) =>
    captureExecution(client, "freshness", async (db) => {
      const c = db as typeof client;
      await c.query("freshness");
      const result = await c.query(sql);
      await c.query("catalog");
      return result.rows;
    });
  const results = await Promise.all([run("UPDATE first"), run("UPDATE second")]);
  expect(results.map((r) => r.affectedRows)).toEqual([2, 5]);
  expect(calls).toBe(6);
});

test("postgres.js raw execution stays lazy and happens once", async () => {
  let raw = 0;
  const client = {
    unsafe(_sql: string) {
      return {
        // Simulate the driver's lazy PromiseLike.
        // oxlint-disable-next-line unicorn/no-thenable
        then() {
          throw Error("must not start object-row execution");
        },
        async raw() {
          raw++;
          return Object.assign([], { command: "DELETE", count: 4 });
        },
      };
    },
  };
  const result = await captureExecution(
    client as unknown as PostgresClient,
    undefined,
    async (db) => await (db as typeof client).unsafe("DELETE FROM items").raw(),
  );
  expect(result.affectedRows).toBe(4);
  expect(raw).toBe(1);
});

test("metadata mode retains runtime validation and observer events", async () => {
  const { subscribeQueries } = await import("../src/runtime.ts");
  const named = "UPDATE items SET id=:p0";
  const sql = createSql<Registry>({
    x: {
      [named]: {
        dialect: "postgres",
        sql: named,
        params: ["p0"],
        inputs: { p0: { nullable: false, type: { kind: "scalar", name: "int4" } } },
      },
    },
  });
  const events: string[] = [];
  const stop = subscribeQueries((event) => events.push(event.phase));
  let calls = 0;
  const db = {
    async query() {
      calls++;
      return { rows: [], command: "UPDATE", rowCount: 2 };
    },
  };
  try {
    expect(await sql.query("x")`UPDATE items SET id=${1}`.runWithMetadata(db)).toEqual({
      rows: [],
      affectedRows: 2,
      command: "UPDATE",
    });
    await rejects(() => sql.query("x")`UPDATE items SET id=${null}`.runWithMetadata(db));
    expect(calls).toBe(1);
    expect(events).toEqual(["start", "end", "start", "error"]);
  } finally {
    stop();
  }
});

for (const runtime of ["node", "bun"])
  test(`native affected-row counts on ${runtime}`, async () => {
    const child = Bun.spawn([runtime, "--env-file=.env", "tests/fixtures/metadata-runtime.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, out + err).toBe(0);
  }, 30000);

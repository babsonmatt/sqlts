import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { observeQuery, subscribeQueries, type QueryEvent } from "../src/query-events.ts";
test("observers retain matching IDs for concurrent calls and survive synchronous failure", async () => {
  const events: QueryEvent[] = [];
  const stop = subscribeQueries((e) => events.push(e));
  const info = { sql: "SELECT 1", source: "test", cardinality: "one" };
  try {
    await Promise.all([observeQuery(info, async () => [1]), observeQuery(info, async () => [2])]);
    const failure = new Error("sync");
    await rejects(
      observeQuery(info, () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    expect(events.map((e) => e.phase)).toEqual(["start", "start", "end", "end", "start", "error"]);
    expect(events[0]!.id).toBe(events[2]!.id);
    expect(events[1]!.id).toBe(events[3]!.id);
    expect(events[4]!.id).toBe(events[5]!.id);
  } finally {
    stop();
  }
});

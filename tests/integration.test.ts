import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { allUsers, rankedUsers, searchUsers, rawSearchUsers } from "../examples/queries.ts";
const db = new SQL(process.env.DATABASE_URL!);
afterAll(() => db.close());

for (const search of [undefined, "Alice", "team", "Bob", "' OR TRUE; --"]) {
  for (const email of [false, true]) {
    test(`matches direct PostgreSQL: search=${search}, email=${email}`, async () => {
      const actual = await searchUsers(10, search, email).run(db);
      const expected = await db`
        SELECT id, name, email FROM reylo_inline_demo.users
        WHERE org_id = 10
          AND (${search === undefined} OR name ILIKE ${`%${search}%`} OR email ILIKE ${`%${search}%`})
          AND (${!email} OR email IS NOT NULL)
        ORDER BY id LIMIT 20`;
      expect([...actual]).toEqual([...expected]);
    });
  }
}
test("optional predicates never remove organization scope", async () => {
  expect((await searchUsers(10, "Alice", false).run(db)).map((r) => r.id)).toEqual([1]);
});
test("no WHERE is valid and nullable values survive decoding", async () => {
  const rows = await allUsers(false).run(db);
  expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  expect(rows[1]!.email).toBeNull();
  expect((await allUsers(true).run(db)).map((r) => r.id)).toEqual([1, 3, 4]);
});
test("CTE variants and native bigint output decoding", async () => {
  expect((await rankedUsers(10, undefined).run(db)).map((r) => r.id)).toEqual([1, 2, 3]);
  expect(await rankedUsers(10, 2).run(db)).toEqual([
    { id: 2, name: "Bob", position: 1n },
    { id: 3, name: "Carol", position: 2n },
  ]);
});

for (const search of [undefined, "Alice"]) {
  for (const email of [false, true]) {
    test(`raw AND fragments: search=${search}, email=${email}`, async () => {
      const actual = await rawSearchUsers(10, search, email).run(db);
      expect(actual.map((r) => r.id)).toEqual(search ? [1] : email ? [1, 3] : [1, 2, 3]);
    });
  }
}

import { mergeUser, arrayItems, recordFields } from "../examples/completion/queries.ts";
import { rejects } from "node:assert/strict";
test("MERGE insert/update return typed rows; transaction leaves demo data unchanged", async () => {
  const id = -Math.floor(Math.random() * 1_000_000_000) - 1;
  const rollback = new Error("intentional test rollback");
  await rejects(
    db.begin(async (tx) => {
      const existing = await tx`SELECT id FROM reylo_inline_demo.users WHERE id=${id}`;
      expect(existing).toHaveLength(0);
      expect(await mergeUser(99, id, "Inserted").run(tx)).toEqual([{ id, name: "Inserted" }]);
      expect(await mergeUser(99, id, "Updated").run(tx)).toEqual([{ id, name: "Updated" }]);
      throw rollback;
    }),
    (error) => error === rollback,
  );
  expect(await db`SELECT id FROM reylo_inline_demo.users WHERE id=${id}`).toHaveLength(0);
});
test("polymorphic array and anonymous-record results agree with generated types", async () => {
  expect(await arrayItems([1, 2, 3]).run(db)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  expect(await recordFields().run(db)).toEqual([{ id: 1, display_name: "Alice" }]);
});

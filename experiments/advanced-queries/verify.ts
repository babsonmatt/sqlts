import { deepEqual, equal } from "node:assert/strict";
import { Pool } from "pg";
import { directory } from "./directory.sqlts";
import { nextPeers } from "./peers.sqlts";
import { spending } from "./spending.sqlts";
import { hierarchy } from "./hierarchy.sqlts";

// Expectations refer to the existing four-user demo fixture. No seed/migration runs.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = await pool.connect();
try {
  await db.query("BEGIN READ ONLY");
  for (const search of [undefined, "team"]) {
    for (const minimum of [undefined, 2]) {
      const rows = await directory(10, search, minimum).run(db);
      deepEqual(
        rows.map((r) => r.id),
        search ? (minimum ? [] : [3]) : [1, 2, 3],
      );
      if (!search) {
        deepEqual(
          rows.map((r) => r.position),
          [1n, 2n, 3n],
        );
        deepEqual(
          rows.map((r) => r.member_count),
          [3n, 3n, 3n],
        );
        deepEqual(
          rows.map((r) => r.contactable_count),
          [2n, 2n, 2n],
        );
      }
    }
  }
  deepEqual(
    (await directory(10, "", 0).run(db)).map((r) => r.id),
    [1, 2, 3],
  );
  deepEqual(await directory(10, "' OR TRUE; --").run(db), []);
  deepEqual(
    (await directory(20).run(db)).map((r) => r.id),
    [4],
  );

  for (const contactable of [false, true]) {
    for (const required of [false, true]) {
      const rows = await nextPeers(10, contactable, required).run(db);
      deepEqual(
        rows.map((r) => [r.id, r.next_id]),
        [[1, contactable ? 3 : 2], [2, 3], ...(required ? [] : [[3, null]])],
      );
    }
  }
  deepEqual(
    (await nextPeers(20).run(db)).map((r) => [r.id, r.next_id]),
    [[4, null]],
  );

  for (const paid of [false, true]) {
    for (const minimum of [undefined, 10000n]) {
      const rows = await spending(10, paid, minimum).run(db);
      deepEqual(
        rows.map((r) => [r.id, r.total_cents]),
        minimum != null
          ? [[1, paid ? 20000n : 25000n]]
          : [
              [1, paid ? 20000n : 25000n],
              [3, 9900n],
              [2, paid ? 0n : 3000n],
            ],
      );
    }
  }
  const allPaid = await spending(10, true, 0n).run(db);
  deepEqual(
    allPaid.map((r) => r.spending_rank),
    [1n, 2n, 3n],
  );
  equal(allPaid.find((r) => r.id === 2)?.largest_order_cents, null);
  deepEqual(
    (await spending(20).run(db)).map((r) => [r.id, r.total_cents]),
    [[4, 99000n]],
  );

  deepEqual(
    (await hierarchy(10, 1).run(db)).map((r) => [r.id, r.depth, r.path]),
    [
      [1, 0, [1]],
      [2, 1, [1, 2]],
      [3, 2, [1, 2, 3]],
    ],
  );
  deepEqual(
    (await hierarchy(10, 1, 0).run(db)).map((r) => r.id),
    [1],
  );
  deepEqual(
    (await hierarchy(10, 1, 1).run(db)).map((r) => r.id),
    [1, 2],
  );
  deepEqual(await hierarchy(20, 1).run(db), []);
  deepEqual(
    (await hierarchy(20, 4).run(db)).map((r) => r.id),
    [4],
  );
  console.log(
    "Advanced examples passed: conditional branches, joins, aggregates, recursion, and organization isolation.",
  );
} finally {
  await db.query("ROLLBACK");
  db.release();
  await pool.end();
}

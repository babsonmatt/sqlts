import type { PostgresClient } from "reylo";
import { directory } from "./directory.sqlts";
import { nextPeers } from "./peers.sqlts";
import { spending } from "./spending.sqlts";
import { hierarchy } from "./hierarchy.sqlts";

// Hover each returned variable or row field: these types come from SQL inference.
export async function explore(db: PostgresClient, orgId: number) {
  const members = await directory(orgId, undefined, 2).run(db);
  const peers = await nextPeers(orgId, true).run(db);
  const leaderboard = await spending(orgId, true, 0n).run(db);
  const tree = await hierarchy(orgId, 1, 3).run(db);

  const memberId = members[0]?.id; // number | undefined
  const position = members[0]?.position; // bigint | undefined
  const nextId = peers[0]?.next_id; // number | null | undefined
  const totalCents = leaderboard[0]?.total_cents; // bigint | undefined
  const path = tree[0]?.path; // (number | null)[] | undefined (conservative elements)

  return { members, peers, leaderboard, tree, memberId, position, nextId, totalCents, path };
}

// bun --preload @sqlts/core/register experiments/advanced-queries/consumer.ts
if (import.meta.main) {
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await explore(db, 10);
    console.log("CTEs + aggregate FILTER + window rank:");
    console.table(result.members);
    console.log("LEFT JOIN LATERAL: next contactable peer:");
    console.table(result.peers);
    console.log("Conditional JOIN + HAVING + spending rank (inline demo orders):");
    console.table(result.leaderboard);
    console.log("Recursive hierarchy (inline demo links):");
    console.table(result.tree);
    console.log("Search inside the CTE:");
    console.table(await directory(10, "team").run(db));
    console.log("HAVING total >= 10000 cents:");
    console.table(await spending(10, true, 10000n).run(db));
  } finally {
    await db.end();
  }
}

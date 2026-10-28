import type { PostgresClient } from "reylo";
import { findUsers } from "./queries.sqlts";

export async function consumeUsers(db: PostgresClient, orgId: number) {
  const users = await findUsers(orgId, 25).run(db);
  const matches = await findUsers(orgId, 10, "alice", true).run(db);

  // if (matches.length > 0) {
  //   const user0 = matches[0];
  //   console.log(user0.name)
  // }

  // Inferred across the .sqlts import; indexing may produce no row.
  const userId = users[0]?.id; // number | undefined
  const userName = users[0]?.name; // string | undefined
  const email = users[0]?.email; // string | null | undefined

  // SQL variants keep email nullable even when onlyWithEmail is true.
  // These operations use the inferred number, string, and nullable string types.
  const labels = matches.map(
    (user) =>
      `${user.id.toFixed(0)}: ${user.name.toUpperCase()} <${user.email?.toLowerCase() ?? "no email"}>`,
  );

  return { users, matches, userId, userName, email, labels };
}

// Run from the repository root:
// bun --preload @sqlts/core/register experiments/user-search/consumer.ts
if (import.meta.main) {
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log(await consumeUsers(db, 10));
  } finally {
    await db.end();
  }
}

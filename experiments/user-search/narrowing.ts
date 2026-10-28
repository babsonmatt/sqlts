import type { PostgresClient } from "reylo";
import { findUsers } from "./queries.sqlts";

// Hover the three email variables below. Their types come from the SQL;
// there are no handwritten result interfaces or type assertions.
export async function inspectNarrowing(db: PostgresClient, orgId: number, flag: boolean) {
  const required = await findUsers(orgId, 10, undefined, true).run(db);
  const optional = await findUsers(orgId, 10).run(db);
  const conditional = await findUsers(orgId, 10, undefined, flag).run(db);

  const requiredEmail = required[0]?.email; // string | undefined
  const optionalEmail = optional[0]?.email; // string | null | undefined
  const conditionalEmail = conditional[0]?.email; // string | null | undefined

  // undefined is still possible because a query can return no rows.
  return { required, optional, conditional, requiredEmail, optionalEmail, conditionalEmail };
}

if (import.meta.main) {
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await inspectNarrowing(db, 10, true);
    console.log("Email required:");
    console.table(result.required);
    console.log("Default (email optional):");
    console.table(result.optional);
  } finally {
    await db.end();
  }
}

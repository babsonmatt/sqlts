import type { PostgresClient } from "reylo";
import { searchUsers, countUsers } from "./search.sqlts";
import { insertUser, deleteWithoutReturning } from "./mutations.sqlts";

// Hover these values: userId is number | undefined; email is string | undefined;
// total is bigint | undefined. These types come from the SQL and database.
export async function inspectUsers(db: PostgresClient, orgId: number) {
  const users = await searchUsers(orgId, undefined, true).run(db);
  const counts = await countUsers(orgId).run(db);
  const userId = users[0]?.id;
  const email = users[0]?.email;
  const total = counts[0]?.total;
  return { users, userId, email, total };
}

// These exported functions are examples for a caller-supplied transaction client.
// Running this demo does not invoke either mutation.
export async function insertExample(transaction: PostgresClient, id: number, orgId: number) {
  const rows = await insertUser(id, orgId, "New user").run(transaction);
  const insertedId = rows[0]?.id;
  return { rows, insertedId };
}
export async function deleteExample(transaction: PostgresClient, id: number, orgId: number) {
  const rows = await deleteWithoutReturning(orgId, id).run(transaction);
  return rows; // never[]: a statement without RETURNING returns an empty array.
}

if (import.meta.main) {
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.table((await inspectUsers(db, 10)).users);
    console.log("Search SQL:", searchUsers(10, "Alice").compile());
    console.log("Insert SQL (not executed):", insertUser(123456, 10, "Example").compile());
  } finally {
    await db.end();
  }
}

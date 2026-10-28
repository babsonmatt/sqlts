import { users } from "./queries.sqlts";
import type { PostgresClient } from "reylo";

export async function showUsers(db: PostgresClient) {
  const rows = await users().run(db);
  const label = rows[0]!.display_name;
  const nullableText: string | null = label;
  // @ts-expect-error The new column is nullable.
  const requiredText: string = label;
  // @ts-expect-error Its type comes from PostgreSQL, not a handwritten row interface.
  const numeric: number | null = label;
  return { rows, nullableText, requiredText, numeric };
}

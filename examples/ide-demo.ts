import type { PostgresClient } from "reylo";
import { searchUsers, rankedUsers } from "./queries.ts";

// IDE TOUR — no database connection or query execution happens on import.
// 1. Open examples/queries.ts and hover query in sql.query("searchUsers").
//    TypeScript shows generated SQL docs. The separate preview LSP also shows
//    live source alternatives, conditions, and $n → expression bindings.
// 2. Hover the variables and properties below to see database-inferred types.
// 3. Uncomment one of the marked lines to see an actual compiler diagnostic.
// 4. Edit SQL in queries.ts: live previews update while typing; inferred types
//    update after bun run generate (or use bun run dev:types to watch saves).

export async function typeTour(db: PostgresClient) {
  const query = searchUsers(10, "Alice", false);
  const rows = await query.run(db); // Hover rows: an array of inferred row types.
  const first = rows[0]; // Hover first: row | undefined (array may be empty).
  if (!first) return;

  const userId = first.id; // number
  const displayName = first.name; // string
  const email = first.email; // string | null
  const uppercaseName = displayName.toUpperCase();
  const emailLabel = email?.toLowerCase() ?? "No email";

  // first.missingColumn;          // Error: SQL did not select this column.
  // first.email.toLowerCase();    // Error: email may be null.
  // searchUsers("10", "A", false); // Error: orgId requires a number.

  const ranked = await rankedUsers(10, 2).run(db);
  const position = ranked[0]?.position; // bigint | undefined, not number.
  // const wrong: number = ranked[0]!.position; // Error: bigint is not number.

  // Honest current boundary: a true condition does not specialize the result type.
  const withEmail = await searchUsers(10, undefined, true).run(db);
  const stillNullable = withEmail[0]?.email; // string | null | undefined

  return { userId, uppercaseName, emailLabel, position, stillNullable };
}

// This file can be run as a plain Bun file without opening a connection.
if (import.meta.main)
  console.log(
    "Open this file and examples/queries.ts in your IDE; hover the marked values and query tags.",
  );

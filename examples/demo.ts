import { SQL } from "bun";
import { searchUsers, allUsers, rankedUsers, rawSearchUsers } from "./queries.ts";
const db = new SQL(process.env.DATABASE_URL!);
try {
  for (const [label, query] of [
    ["Organization only", searchUsers(10, undefined, false)],
    ["Name OR email contains 'team'", searchUsers(10, "team", false)],
    ["Only users with email", searchUsers(10, undefined, true)],
    ["All optional predicates absent", allUsers(false)],
    ["CTE and window function", rankedUsers(10, 2)],
    ["Raw inline AND fragments", rawSearchUsers(10, "Alice", true)],
  ] as const) {
    console.log(`\n${label}`, query.compile());
    console.table(await query.run(db));
  }
} finally {
  await db.close();
}

import postgres from "postgres";
import { userIds, userNames, searchUsers, searchUsersShorthand } from "./queries.sqlts";
const db = postgres(process.env.DATABASE_URL!);
try {
  console.log("IDs:", await userIds(10).run(db));
  console.log("Names:", await userNames(10).run(db));
  console.log("Search:", await searchUsers(10, "Alice").run(db));
  console.log("Shorthand search:", await searchUsersShorthand(10, "Alice").run(db));
  console.log("Empty search:", await searchUsersShorthand(10, "").run(db));
  console.log("With email:", await searchUsersShorthand(10, undefined, true).run(db));
} finally {
  await db.end();
}

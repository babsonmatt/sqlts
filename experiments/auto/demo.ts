import { SQL } from "bun";
import { userIds, userNames, searchUsers } from "./queries.ts";
const db = new SQL(process.env.DATABASE_URL!);
try {
  console.log("IDs:", await userIds(10).run(db));
  console.log("Names:", await userNames(10).run(db));
  console.log("Search:", await searchUsers(10, "Alice").run(db));
} finally {
  await db.close();
}

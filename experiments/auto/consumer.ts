import type { PostgresClient } from "reylo";
import { userIds, userNames } from "./queries.ts";

// Hover the variables or complete row properties here, across the module boundary.
export async function consume(db: PostgresClient) {
  const ids = await userIds(10).run(db);
  const names = await userNames(10).run(db);
  const userId = ids[0]?.id;
  const userName = names[0]?.name;
  const email = names[0]?.email;
  return { userId, userName, email };
}

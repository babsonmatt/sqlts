import { SQL } from "bun";
const db = new SQL(process.env.DATABASE_URL!);
try {
  await db.unsafe(await Bun.file(new URL("../db/schema.sql", import.meta.url)).text());
  console.log("Independent reylo_inline_demo schema ready (4 demo users).");
} finally {
  await db.close();
}

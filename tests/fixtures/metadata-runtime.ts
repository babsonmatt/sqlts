import { strict as assert } from "node:assert";
import { Pool } from "pg";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PostgresClient } from "reylo";
import { createSql, type Registry } from "../../src/runtime.ts";

async function exercise(
  db: PostgresClient,
  exec: (sql: string) => Promise<unknown>,
  label: string,
) {
  await exec(
    "CREATE TEMP TABLE sqlts_count_test (id int PRIMARY KEY, name text NOT NULL) ON COMMIT DROP",
  );
  async function run(text: string) {
    const sql = createSql<Registry>({
      x: {
        [text]: {
          dialect: "postgres",
          sql: text,
          params: [],
          columns: text.includes("AS big")
            ? [
                ["id", "int"],
                ["big", "int8"],
                ["payload", "json"],
              ]
            : undefined,
        },
      },
    });
    const strings = Object.freeze(
      Object.assign([text], { raw: Object.freeze([text]) }),
    ) as unknown as TemplateStringsArray;
    return sql.query("x")(strings).runWithMetadata(db);
  }
  assert.equal(
    (await run("INSERT INTO sqlts_count_test VALUES (1,'a'),(2,'b'),(3,'c')")).affectedRows,
    3,
  );
  assert.equal((await run("UPDATE sqlts_count_test SET name=name")).rows.length, 0);
  assert.equal((await run("UPDATE sqlts_count_test SET name=name")).affectedRows, 3);
  assert.equal((await run("UPDATE sqlts_count_test SET name=name WHERE id=99")).affectedRows, 0);
  const returned = await run(
    "UPDATE sqlts_count_test SET name=name RETURNING id, id::bigint AS big, jsonb_build_object('name',name) AS payload",
  );
  assert.equal(returned.affectedRows, 3);
  assert.equal(returned.rows.length, 3);
  assert.equal(typeof (returned.rows[0] as { big: bigint }).big, "bigint");
  assert.equal(typeof (returned.rows[0] as { payload: { name: string } }).payload.name, "string");
  assert.equal(
    (await run("INSERT INTO sqlts_count_test VALUES (1,'a') ON CONFLICT DO NOTHING")).affectedRows,
    0,
  );
  assert.equal(
    (
      await run(
        "INSERT INTO sqlts_count_test VALUES (1,'b') ON CONFLICT (id) DO UPDATE SET name=excluded.name",
      )
    ).affectedRows,
    1,
  );
  assert.equal((await run("DELETE FROM sqlts_count_test WHERE id=3")).affectedRows, 1);
  assert.equal(
    (
      await run(
        "MERGE INTO sqlts_count_test t USING (VALUES (1,'x'),(4,'y')) s(id,name) ON t.id=s.id WHEN MATCHED THEN UPDATE SET name=s.name WHEN NOT MATCHED THEN INSERT VALUES(s.id,s.name)",
      )
    ).affectedRows,
    2,
  );
  const selected = await run("SELECT id FROM sqlts_count_test");
  assert.equal(selected.affectedRows, 0);
  assert.equal(selected.rows.length, 3);
  assert.equal(
    (
      await run(
        "WITH changed AS (UPDATE sqlts_count_test SET name=name RETURNING id) SELECT count(*) FROM changed",
      )
    ).affectedRows,
    0,
  );
  assert.deepEqual(
    (
      await Promise.all([
        run("UPDATE sqlts_count_test SET name=name WHERE id=1"),
        run("UPDATE sqlts_count_test SET name=name WHERE id=99"),
      ])
    ).map((r) => r.affectedRows),
    [1, 0],
  );
  console.log(label, "counts and decoding passed");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await exercise(client, (s) => client.query(s), "pg");
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
const ormPool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const orm = drizzlePg(ormPool);
  await orm.transaction(async (tx) => {
    // Obtain no separate connection: all writes must use this transaction.
    await exercise(
      tx,
      async (text) => {
        const { sql } = await import("drizzle-orm");
        return tx.execute(sql.raw(text));
      },
      "Drizzle pg transaction",
    );
  });
} finally {
  await ormPool.end();
}
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  await sql.begin(async (tx) => {
    await exercise(tx, async (s) => await tx.unsafe(s), "postgres.js");
  });
  await drizzlePostgres(sql).transaction(async (tx) => {
    await exercise(
      tx,
      async (text) => {
        const { sql: tag } = await import("drizzle-orm");
        return tx.execute(tag.raw(text));
      },
      "Drizzle postgres.js transaction",
    );
  });
} finally {
  await sql.end();
}
if (typeof Bun !== "undefined") {
  const { SQL } = await import("bun");
  const bun = new SQL(process.env.DATABASE_URL!);
  try {
    await bun.begin(async (tx) => {
      await exercise(tx, async (s) => await tx.unsafe(s), "Bun.SQL");
    });
  } finally {
    await bun.close();
  }
}

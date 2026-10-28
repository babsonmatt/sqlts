import assert from "node:assert/strict";
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { dbmatePath, dbmateVersion, run, migrate } from "./dbmate.ts";
import { schemaRevision, schemaSignal } from "../../src/sqlts/schema-refresh.ts";
import { dependencyClient } from "../../tests/dependency-watch-client.ts";
import { client } from "../../tests/lsp-client.ts";
import { position } from "../../src/preview.ts";

const root = resolve(import.meta.dir, "../..");
export async function demoMigrations() {
  const version = await run([dbmatePath, "--version"], root);
  assert.equal(
    version.output.trim(),
    `dbmate version ${dbmateVersion}`,
    "Run bun run dbmate:install first",
  );
  const base = process.env.SQLTS_MIGRATION_ADMIN_URL ?? process.env.DATABASE_URL;
  assert(base, "Set SQLTS_MIGRATION_ADMIN_URL (or the local development DATABASE_URL)");
  const url = new URL(base);
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
    "This disposable demo only runs on a local PostgreSQL server",
  );
  const database = "sqlts_dbmate_" + crypto.randomUUID().replaceAll("-", "");
  await mkdir(resolve(root, "work"), { recursive: true });
  const project = await mkdtemp(resolve(root, "work/dbmate-demo-"));
  await cp(resolve(root, "experiments/dbmate/template"), project, { recursive: true });
  await writeFile(resolve(project, "package.json"), '{"private":true,"type":"module"}');
  const migrations = resolve(project, "db/migrations");
  const addition = resolve(migrations, "20261026000200_add_display_name.sql");
  const second = await readFile(addition, "utf8");
  await rm(addition);
  url.pathname = "/" + database;
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
  const env = {
    ...process.env,
    REYLO_CONFIG: undefined,
    DATABASE_URL: url.href,
    SQLTS_DBMATE_DATABASE_URL: url.href,
  };
  // Never write the temporary connection string into files or reports.
  const admin = new Client({ connectionString: base });
  const db = new Client({ connectionString: url.href });
  const facts: string[] = [];
  async function successfulMigration() {
    const result = await migrate(project, env);
    assert.equal(
      result.code,
      0,
      result.output.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[database URL redacted]"),
    );
  }
  let created = false,
    connected = false;
  let native: ReturnType<typeof dependencyClient> | undefined;
  let preview: ReturnType<typeof client> | undefined;
  const check = () =>
    run(
      [
        Bun.which("node")!,
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--runExternalCode",
        "--pretty",
        "false",
        "-p",
        "tsconfig.json",
      ],
      project,
      env,
    );
  const queryFile = resolve(project, "queries.sqlts"),
    callerFile = resolve(project, "consumer.ts");
  const query = await readFile(queryFile, "utf8"),
    caller = await readFile(callerFile, "utf8");
  const quri = pathToFileURL(queryFile).href,
    curi = pathToFileURL(callerFile).href;
  async function until(label: string, test: () => Promise<boolean>) {
    const deadline = Date.now() + 12000;
    do {
      if (await test()) return;
      await Bun.sleep(60);
    } while (Date.now() < deadline);
    throw Error(`Timed out: ${label}`);
  }
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await db.connect();
    connected = true;
    assert.equal((await db.query("SELECT current_database() AS db")).rows[0].db, database);
    await successfulMigration();
    await db.query("INSERT INTO users(name) VALUES ('Ada')");
    const before = await check();
    assert.notEqual(before.code, 0);
    assert.match(before.output, /display_name.*does not exist/);
    facts.push("Baseline applied by dbmate; fresh SQL-aware check rejects the future column.");
    native = dependencyClient({
      cwd: project,
      env,
      command: [
        Bun.which("node")!,
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--lsp",
        "--stdio",
      ],
    });
    await native.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(project).href,
      initializationOptions: { runExternalCode: true },
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    native.notify("initialized", {});
    native.notify("textDocument/didOpen", {
      textDocument: { uri: curi, text: caller, version: 1, languageId: "typescript" },
    });
    const diagnostics = () =>
      native!.request("textDocument/diagnostic", { textDocument: { uri: quri } });
    const hover = () =>
      native!.request("textDocument/hover", {
        textDocument: { uri: curi },
        position: position(caller, caller.indexOf("label =")),
      });
    assert.match(JSON.stringify(await diagnostics()), /display_name.*does not exist/);
    preview = client(
      [Bun.which("node")!, resolve(root, "src/sqlts/preview-cli.ts"), "--project", project],
      env,
      undefined,
      undefined,
      project,
    );
    await preview.request("initialize", { rootUri: pathToFileURL(project).href });
    preview.notify("textDocument/didOpen", {
      textDocument: { uri: quri, text: query, version: 1, languageId: "typescript" },
    });
    const complete = async () =>
      (await preview!.request("textDocument/completion", {
        textDocument: { uri: quri },
        position: position(query, query.indexOf("u.id") + 2),
      })) as { items: { label: string; detail: string }[] };
    assert(!(await complete()).items.some((i) => i.label === "display_name"));
    await writeFile(addition, second);
    // Two runners contend for the migration lock; only one records/applies the change.
    const applied = await Promise.all([migrate(project, env), migrate(project, env)]);
    assert(applied.every((r) => r.code === 0));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 2);
    await until(
      "native SQL diagnostics clear after migration",
      async () => !JSON.stringify(await diagnostics()).includes("does not exist"),
    );
    await until("nullable text hover", async () =>
      JSON.stringify(await hover()).includes("string | null"),
    );
    await until("new column completion", async () =>
      (await complete()).items.some((i) => i.label === "display_name" && i.detail.includes("text")),
    );
    assert.equal((await check()).code, 0);
    facts.push(
      "Concurrent dbmate runs applied the addition once; editor diagnostics, nullable string hover and completion refreshed without source edits.",
    );
    // Execute the same SQLTS query through both runtime loaders against the migrated DB.
    await writeFile(
      resolve(project, "run.ts"),
      `import {Client} from 'pg';import {users} from './queries.sqlts';const db=new Client({connectionString:process.env.SQLTS_DBMATE_DATABASE_URL});await db.connect();try{console.log(JSON.stringify(await users().run(db)));}finally{await db.end();}`,
    );
    for (const [binary, flag] of [
      [Bun.which("node")!, "--import"],
      [process.execPath, "--preload"],
    ]) {
      const result = await run(
        [binary!, flag!, "reylo-sqlts-experiment/register", "run.ts"],
        project,
        env,
      );
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(JSON.parse(result.stdout), [{ id: 1, name: "Ada", display_name: null }]);
    }
    facts.push("Node and Bun execute the inferred query and return the expected null value.");
    await successfulMigration();
    assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 2);
    // Exercise invalidation of a previously successful analysis with unchanged source.
    const third = resolve(migrations, "20261026000300_change_display_name.sql");
    await writeFile(
      third,
      "-- migrate:up\nALTER TABLE users ALTER COLUMN display_name TYPE integer USING NULL;\n-- migrate:down\nALTER TABLE users ALTER COLUMN display_name TYPE text USING display_name::text;\n",
    );
    await successfulMigration();
    await until("number hover replaces successful string analysis", async () =>
      JSON.stringify(await hover()).includes("number | null"),
    );
    await until("integer completion", async () =>
      (await complete()).items.some(
        (i) => i.label === "display_name" && i.detail.includes("integer"),
      ),
    );
    assert.notEqual((await check()).code, 0);
    assert.equal((await migrate(project, env, "rollback")).code, 0);
    await rm(third);
    await until("rollback restores text inference", async () =>
      JSON.stringify(await hover()).includes("string | null"),
    );
    assert.equal((await check()).code, 0);
    facts.push(
      "A type-changing migration invalidates cached successful types; caller checking fails, then recovers after rollback.",
    );
    const bad = resolve(migrations, "20261026000400_failure.sql");
    await writeFile(
      bad,
      "-- migrate:up\nALTER TABLE users ADD COLUMN should_rollback boolean;\nSELECT 1 / 0;\n-- migrate:down\nALTER TABLE users DROP COLUMN should_rollback;\n",
    );
    const signal = schemaRevision(schemaSignal(project));
    assert.notEqual((await migrate(project, env)).code, 0);
    assert.notEqual(schemaRevision(schemaSignal(project)), signal);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='users' AND column_name='should_rollback'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n, 2);
    await rm(bad);
    assert.equal((await check()).code, 0);
    facts.push(
      "Transactional failure rolls back DDL and ledger changes; failure still signals schema refresh because other batches may partially commit.",
    );
    // Dropping the added column must invalidate already-valid query diagnostics too.
    assert.equal((await migrate(project, env, "rollback")).code, 0);
    await until("column removal diagnostic", async () =>
      JSON.stringify(await diagnostics()).includes("does not exist"),
    );
    await until(
      "removed column disappears",
      async () => !(await complete()).items.some((i) => i.label === "display_name"),
    );
    assert.notEqual((await check()).code, 0);
    await successfulMigration();
    await until(
      "reapply clears error",
      async () => !JSON.stringify(await diagnostics()).includes("does not exist"),
    );
    assert.equal((await check()).code, 0);
    assert.equal(await readFile(queryFile, "utf8"), query);
    assert.equal(await readFile(callerFile, "utf8"), caller);
    assert(native.notifications > 0);
    facts.push(
      "Rollback/remigration clears and restores the column in both editor services; query and caller files remain unchanged.",
    );
    return {
      dbmate: dbmateVersion,
      facts,
      generatedQueryFiles: false,
      cleanup: "temporary database and project removed",
    };
  } finally {
    try {
      await native?.close();
      await preview?.close();
    } finally {
      try {
        if (connected) await db.end();
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        } finally {
          await admin.end();
          await rm(project, { recursive: true, force: true });
        }
      }
    }
  }
}
if (import.meta.main) {
  const report = await demoMigrations();
  const output = resolve(root, "work/dbmate-demo-results.json");
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  for (const fact of report.facts) console.log("PASS " + fact);
  console.log("Temporary database removed. Report: " + output);
}

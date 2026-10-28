import { dependencyClient } from "./dependency-watch-client.ts";
import { client } from "./lsp-client.ts";
import { pathToFileURL } from "node:url";
import { position } from "../src/preview.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
const root = resolve(".");
const dir = await mkdtemp(resolve(tmpdir(), "sqlts-installed-"));
const production = await mkdtemp(resolve(tmpdir(), "sqlts-production-"));
afterAll(() => rm(production, { recursive: true, force: true }));
afterAll(() => rm(dir, { recursive: true, force: true }));
async function run(
  args: string[],
  cwd = dir,
  env: Record<string, string | undefined> = process.env,
) {
  const p = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, output: out + err };
}
test("a private tarball checks and runs outside the checkout, and builds an analyzer-free deployment", async () => {
  const packed = await run([process.execPath, "scripts/pack-sqlts.ts"], root);
  expect(packed.code, packed.output).toBe(0);
  const { tarball, companions } = JSON.parse(packed.output.trim()) as {
    tarball: string;
    companions: Record<string, string>;
  };
  await writeFile(
    resolve(dir, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "check:sql": "reylo-sqlts check -p tsconfig.json",
        check: "bun run check:sql",
      },
      dependencies: {
        "reylo-sqlts-experiment": tarball,
        reylo: companions.reylo!,
        "@reylosql/postgres": companions["@reylosql/postgres"]!,
        typescript: "7.1.0-beta",
        pg: "8.23.1",
        "@types/node": "26.6.5",
        "@types/pg": "8.23.1",
      },
    }),
  );
  const installed = await run([process.execPath, "install", "--offline", "--ignore-scripts"]);
  expect(installed.code, installed.output).toBe(0);
  await writeFile(
    resolve(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
      files: ["queries.sqlts", "consumer.ts", "fragments.sqlts"],
    }),
  );
  await writeFile(
    resolve(dir, "fragments.sqlts"),
    `import {sql} from 'reylo-sqlts-experiment';export const tenant=(id:number)=>sql.fragment\`org_id=\${id}\`;`,
  );
  await writeFile(
    resolve(dir, "queries.sqlts"),
    `import {sql} from 'reylo-sqlts-experiment';import {tenant} from './fragments.sqlts';export const users=(id:number)=>sql\`SELECT id,name FROM reylo_inline_demo.users WHERE \${tenant(id)} ORDER BY id\`;`,
  );
  await writeFile(
    resolve(dir, "consumer.ts"),
    `import {users} from './queries.sqlts';import type {PostgresClient} from 'reylo';export async function consume(db:PostgresClient){const rows=await users(10).run(db);const name:string=rows[0]!.name;return name;}console.log(JSON.stringify(users(10).compile()));`,
  );
  const checked = await run([
    Bun.which("node")!,
    "node_modules/reylo-sqlts-experiment/src/sqlts/cli.js",
    "check",
    "-p",
    "tsconfig.json",
  ]);
  expect(checked.code, checked.output).toBe(0);
  // Bun dispatches the package script; the installed SQLTS CLI invokes the native
  // mapper-enabled TypeScript compiler. This is not Bun's built-in checker.
  const shortcut = await run([process.execPath, "check"]);
  expect(shortcut.code, shortcut.output).toBe(0);
  expect(shortcut.output).toContain("reylo-sqlts check");
  const queryFile = resolve(dir, "queries.sqlts");
  const consumerFile = resolve(dir, "consumer.ts");
  const helperFile = resolve(dir, "fragments.sqlts");
  const querySource = await readFile(queryFile, "utf8");
  const consumerSource = await readFile(consumerFile, "utf8");
  const helperSource = await readFile(helperFile, "utf8");
  for (const [file, source, invalid, diagnostic] of [
    [
      queryFile,
      querySource,
      querySource.replace("SELECT id,name", "SELECT missing_shortcut_column,name"),
      "missing_shortcut_column",
    ],
    [
      consumerFile,
      consumerSource,
      consumerSource.replace("users(10)", 'users("wrong")'),
      "not assignable",
    ],
    [
      consumerFile,
      consumerSource,
      consumerSource.replace("rows[0]!.name", "rows[0]!.missing_result_field"),
      "missing_result_field",
    ],
    [
      helperFile,
      helperSource,
      helperSource.replace("org_id=", "missing_helper_column="),
      "missing_helper_column",
    ],
  ]) {
    try {
      await writeFile(file!, invalid!);
      const rejected = await run([process.execPath, "check"]);
      expect(rejected.code, rejected.output).toBeGreaterThan(0);
      expect(rejected.output).toContain(diagnostic!);
    } finally {
      await writeFile(file!, source!);
    }
  }
  const recovered = await run([process.execPath, "check"]);
  expect(recovered.code, recovered.output).toBe(0);
  // Use only the installed compiler/preview executable, with the new project as cwd.
  const native = dependencyClient({
    command: [
      Bun.which("node")!,
      resolve(dir, "node_modules/typescript/bin/tsc"),
      "--lsp",
      "--stdio",
    ],
    cwd: dir,
  });
  const callerUri = pathToFileURL(resolve(dir, "consumer.ts")).href;
  const callerSource = await readFile(resolve(dir, "consumer.ts"), "utf8");
  try {
    await native.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      initializationOptions: { runExternalCode: true },
      capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } },
    });
    native.notify("initialized", {});
    native.notify("textDocument/didOpen", {
      textDocument: { uri: callerUri, languageId: "typescript", version: 1, text: callerSource },
    });
    const hover = await native.request("textDocument/hover", {
      textDocument: { uri: callerUri },
      position: position(callerSource, callerSource.indexOf("rows=await")),
    });
    expect(JSON.stringify(hover)).toContain("name: string");
    expect(JSON.stringify(hover)).toContain("id: number");
    const notified = native.notifications;
    const refreshed = await run([
      Bun.which("node")!,
      resolve(dir, "node_modules/reylo-sqlts-experiment/src/sqlts/cli.js"),
      "refresh-schema",
      "--project",
      dir,
    ]);
    expect(refreshed.code, refreshed.output).toBe(0);
    for (let attempt = 0; attempt < 40 && native.notifications === notified; attempt++)
      await Bun.sleep(50);
    expect(native.notifications).toBeGreaterThan(notified);
    const refreshedHover = await native.request("textDocument/hover", {
      textDocument: { uri: callerUri },
      position: position(callerSource, callerSource.indexOf("rows=await")),
    });
    expect(JSON.stringify(refreshedHover)).toContain("name: string");
    const helperFile = resolve(dir, "fragments.sqlts"),
      original = await readFile(helperFile, "utf8");
    const diagnostic = () =>
      native.request("textDocument/diagnostic", {
        textDocument: { uri: pathToFileURL(resolve(dir, "queries.sqlts")).href },
      });
    for (const broken of [true, false]) {
      await writeFile(helperFile, broken ? original.replace("org_id=", "id2=") : original);
      let current = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        current = JSON.stringify(await diagnostic());
        if (current.includes("id2") === broken) break;
        await Bun.sleep(50);
      }
      expect(current.includes("id2")).toBe(broken);
    }
    expect(native.notifications).toBeGreaterThan(0);
  } finally {
    await native.close();
  }
  await writeFile(resolve(dir, "bunfig.toml"), 'preload = ["./must-not-load.ts"]\n');
  await writeFile(
    resolve(dir, "must-not-load.ts"),
    'throw Error("Editor executed application preload");',
  );
  const preview = client(
    [
      Bun.which("node")!,
      resolve(dir, "node_modules/reylo-sqlts-experiment/src/sqlts/preview-cli.js"),
      "--project",
      dir,
    ],
    { DATABASE_URL: process.env.DATABASE_URL },
    undefined,
    undefined,
    dir,
  );
  const queryUri = pathToFileURL(resolve(dir, "queries.sqlts")).href;
  const editing =
    'import {sql} from "reylo-sqlts-experiment";export const query=()=>sql`SELECT u. FROM reylo_inline_demo.users u`;';
  try {
    await preview.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {},
    });
    preview.notify("initialized", {});
    preview.notify("textDocument/didOpen", {
      textDocument: { uri: queryUri, languageId: "typescript", version: 1, text: editing },
    });
    const suggestions = await preview.request("textDocument/completion", {
      textDocument: { uri: queryUri },
      position: position(editing, editing.indexOf("u. FROM") + 2),
    });
    expect(JSON.stringify(suggestions)).toContain('"label":"email"');
    expect(JSON.stringify(suggestions)).toContain('"label":"id"');
    const colors = (await preview.request("textDocument/semanticTokens/full", {
      textDocument: { uri: queryUri },
    })) as { data: number[] };
    expect(colors.data.length).toBeGreaterThan(0);
    preview.notify("textDocument/didClose", { textDocument: { uri: queryUri } });
    preview.notify("textDocument/didOpen", {
      textDocument: { uri: callerUri, languageId: "typescript", version: 1, text: callerSource },
    });
    const sqlHover = await preview.request("textDocument/hover", {
      textDocument: { uri: callerUri },
      position: position(callerSource, callerSource.lastIndexOf("users(10)")),
    });
    expect(JSON.stringify(sqlHover)).toContain("SELECT id,name");
    expect(JSON.stringify(sqlHover)).toContain("$1 = 10");
  } finally {
    await preview.close();
    await rm(resolve(dir, "bunfig.toml"));
    await rm(resolve(dir, "must-not-load.ts"));
  }
  for (const args of [
    [Bun.which("node")!, "--import", "reylo-sqlts-experiment/register", "consumer.ts"],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", "consumer.ts"],
  ]) {
    const executed = await run(args);
    expect(executed.code, executed.output).toBe(0);
    expect(executed.output).toContain('"values":[10]');
  }
  await writeFile(
    resolve(dir, "build.ts"),
    `import {buildSqlts} from 'reylo-sqlts-experiment/build';await buildSqlts('./consumer.ts','./deployment.mjs');`,
  );
  const built = await run([process.execPath, "build.ts"]);
  expect(built.code, built.output).toBe(0);
  const bundle = await readFile(resolve(dir, "deployment.mjs"), "utf8");
  expect(bundle).not.toContain(root);
  expect(bundle).not.toContain("@reylosql/postgres");
  expect(bundle).not.toContain("typescript-ast");
  await writeFile(
    resolve(production, "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: {
        reylo: resolve(root, "vendor/reylo/reylo-0.5.0-sqlts.c8a03f9.tgz"),
        pg: "8.23.1",
      },
    }),
  );
  await writeFile(resolve(production, "deployment.mjs"), bundle);
  const prodInstall = await run(
    [process.execPath, "install", "--offline", "--ignore-scripts"],
    production,
  );
  expect(prodInstall.code, prodInstall.output).toBe(0);
  await writeFile(
    resolve(production, "run.mjs"),
    `import {createRequire} from 'node:module';import {strict as assert} from 'node:assert';import {Pool} from 'pg';import {consume} from './deployment.mjs';
  const require=createRequire(import.meta.url);assert.throws(()=>require.resolve('typescript-ast'));assert.throws(()=>require.resolve('reylo-sqlts-experiment'));
  const db=new Pool({connectionString:process.env.DATABASE_URL});try{assert.equal(await consume(db),'Alice');}finally{await db.end();}`,
  );
  const executedProduction = await run([Bun.which("node")!, "run.mjs"], production);
  expect(executedProduction.code, executedProduction.output).toBe(0);
  const offline = await run([Bun.which("node")!, "deployment.mjs"], production, {
    ...process.env,
    DATABASE_URL: "postgres://invalid:invalid@127.0.0.1:1/unavailable",
  });
  expect(offline.code, offline.output).toBe(0);
  expect(offline.output).toContain('"values":[10]');
}, 60_000);

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, readFile, rm, rename } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectDependencies } from "../src/sqlts/dependencies.ts";
import { DependencyWatch } from "../src/sqlts/dependency-watch.ts";
import { position } from "../src/preview.ts";
import { dependencyClient } from "./dependency-watch-client.ts";

async function fixture() {
  const dir = await mkdtemp(resolve("work/sqlts-watch-"));
  const config = resolve(dir, "app/tsconfig.json"),
    query = resolve(dir, "app/query.sqlts"),
    consumer = resolve(dir, "app/caller.ts"),
    helper = resolve(dir, "shared/outer.sqlts"),
    leaf = resolve(dir, "shared/leaf.sqlts");
  await mkdir(dirname(config), { recursive: true });
  await mkdir(dirname(helper), { recursive: true });
  const leafText =
      'import {sql} from "reylo-sqlts-experiment";export function columns(){return sql.fragment`id, email`;}',
    queryText =
      'import {sql} from "reylo-sqlts-experiment";import {columns} from "../shared/outer.sqlts";export const users=()=>sql`SELECT ${columns()} FROM reylo_inline_demo.users`;',
    callerText =
      'import {users} from "./query.sqlts";import type {PostgresClient} from "reylo";export async function demo(db:PostgresClient){const value=(await users().run(db))[0]?.email;return value;}';
  await writeFile(
    resolve(dir, "base.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: ["node"],
        noUncheckedIndexedAccess: true,
      },
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      extends: "../base.json",
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
      files: ["caller.ts"],
    }),
  );
  await writeFile(consumer, callerText);
  await writeFile(query, queryText);
  await writeFile(
    helper,
    'import {columns as leaf} from "./leaf.sqlts";export function columns(){return leaf();}',
  );
  await writeFile(leaf, leafText);
  return { dir, config, query, consumer, helper, leaf, leafText, queryText, callerText };
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  do {
    if (await check()) return;
    await Bun.sleep(60);
  } while (Date.now() < deadline);
  throw Error("Timed out waiting for automatic dependency refresh");
}

test("dependency identity follows project imports, nested external helpers, missing files and inherited configs", async () => {
  const f = await fixture();
  try {
    const first = projectDependencies(f.config);
    for (const path of [
      f.config,
      resolve(f.dir, "base.json"),
      f.query,
      f.consumer,
      f.helper,
      f.leaf,
    ])
      expect(first.watchedFiles).toContain(path);
    await writeFile(f.consumer, f.callerText + "\n// body edit");
    expect(projectDependencies(f.config).identity).toBe(first.identity);
    await writeFile(resolve(f.dir, "unrelated.sqlts"), 'throw Error("Never execute this")');
    expect(projectDependencies(f.config).identity).toBe(first.identity);
    await writeFile(f.leaf, f.leafText.replace("id, email", "id, name AS email"));
    expect(projectDependencies(f.config).identity).not.toBe(first.identity);
    await rm(f.leaf);
    const missing = projectDependencies(f.config);
    expect(missing.watchedFiles).toContain(f.leaf);
    await writeFile(f.leaf, f.leafText);
    expect(projectDependencies(f.config).identity).toBe(first.identity);
    await writeFile(
      f.helper,
      'import {columns} from "./new.sqlts";export function selected(){return columns();}',
    );
    expect(projectDependencies(f.config).watchedFiles).toContain(
      resolve(f.dir, "shared/new.sqlts"),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("dependency signal coalesces saves, ignores unchanged/unrelated files and survives atomic replacement", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-signal-")),
    file = join(dir, "helper.sqlts"),
    monitor = new DependencyWatch();
  try {
    await writeFile(file, "one");
    monitor.update([file]);
    await writeFile(join(dir, "unrelated"), "x");
    await writeFile(file, "one");
    await Bun.sleep(120);
    expect(await readFile(monitor.file, "utf8")).toBe("0");
    await writeFile(file, "two");
    await writeFile(file, "three");
    await writeFile(file, "four");
    await until(async () => (await readFile(monitor.file, "utf8")) === "1");
    await writeFile(file + ".tmp", "five");
    await rename(file + ".tmp", file);
    await until(async () => (await readFile(monitor.file, "utf8")) === "2");
    await rm(file);
    await until(async () => (await readFile(monitor.file, "utf8")) === "3");
    await writeFile(file, "six");
    await until(async () => (await readFile(monitor.file, "utf8")) === "4");
  } finally {
    monitor.close();
    await rm(dir, { recursive: true, force: true });
  }
  expect(await Bun.file(monitor.file).exists()).toBe(false);
});

test("saved nested helper edits refresh closed-query types and SQL diagnostics without consumer edits", async () => {
  const f = await fixture(),
    lsp = dependencyClient();
  const uri = pathToFileURL(f.consumer).href,
    quri = pathToFileURL(f.query).href;
  const hover = () =>
    lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: position(f.callerText, f.callerText.indexOf("value=")),
    });
  const diagnostics = () => lsp.request("textDocument/diagnostic", { textDocument: { uri: quri } });
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dirname(f.config)).href,
      initializationOptions: { runExternalCode: true },
      capabilities: {
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
        textDocument: { hover: { contentFormat: ["markdown"] } },
      },
    });
    lsp.notify("initialized", {});
    // Only the .ts caller is open; both SQLTS levels remain closed.
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: f.callerText },
    });
    expect(JSON.stringify(await hover())).toContain("string | null | undefined");
    expect(lsp.registrations).toBeGreaterThan(0);
    await writeFile(f.leaf + ".tmp", f.leafText.replace("id, email", "id, name AS email"));
    await rename(f.leaf + ".tmp", f.leaf);
    await until(async () => JSON.stringify(await hover()).includes("string | undefined"));
    await writeFile(f.leaf, f.leafText.replace("id, email", "id2, email"));
    await until(async () => JSON.stringify(await diagnostics()).includes("id2"));
    await writeFile(f.leaf, f.leafText);
    await until(async () => !JSON.stringify(await diagnostics()).includes("id2"));
    expect(JSON.stringify(await hover())).toContain("string | null | undefined");
    expect(await readFile(f.consumer, "utf8")).toBe(f.callerText);
    expect(await readFile(f.query, "utf8")).toBe(f.queryText);
  } finally {
    await lsp.close();
    await rm(f.dir, { recursive: true, force: true });
  }
}, 20000);

test("fresh CLI checks catch and clear saved shared errors without an editor or generation", async () => {
  const f = await fixture();
  const check = async () => {
    const child = Bun.spawn(
      [
        Bun.which("node")!,
        "--env-file=.env",
        "node_modules/typescript/bin/tsc",
        "--runExternalCode",
        "--pretty",
        "false",
        "-p",
        f.config,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, text: out + err };
  };
  try {
    expect((await check()).code).toBe(0);
    await writeFile(f.leaf, f.leafText.replace("id, email", "id2, email"));
    const invalid = await check();
    expect(invalid.code).not.toBe(0);
    expect(invalid.text).toContain("id2");
    await writeFile(f.leaf, f.leafText);
    expect((await check()).code).toBe(0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
}, 20000);

test("a save racing initial watcher registration is not lost", async () => {
  const f = await fixture(),
    monitor = new DependencyWatch();
  try {
    const before = projectDependencies(f.config);
    await writeFile(f.leaf, f.leafText.replace("id, email", "id, name AS email"));
    monitor.update(before.watchedFiles, before.snapshots);
    await until(async () => (await readFile(monitor.file, "utf8")) === "1");
  } finally {
    monitor.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

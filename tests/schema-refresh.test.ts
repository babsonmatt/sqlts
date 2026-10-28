import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { client } from "./lsp-client.ts";
import { position } from "../src/preview.ts";
import { generate } from "../scripts/generate.ts";

test("migration refreshes completion, diagnostics and generated types in a separate consumer project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reylo-editor-consumer-"));
  await mkdir(join(dir, "node_modules"));
  await symlink(resolve("."), join(dir, "node_modules/reylo-inline-sql-experiment"));
  const schema = "inline_refresh_" + crypto.randomUUID().replaceAll("-", "");
  const db = new SQL(process.env.DATABASE_URL!, { max: 1 });
  type Diagnostic = { uri: string; diagnostics: { message: string }[] };
  const diagnostics: Diagnostic[] = [];
  const lsp = client(
    [
      process.execPath,
      "--no-env-file",
      join(dir, "node_modules/reylo-inline-sql-experiment/scripts/preview-server.ts"),
      "--project",
      dir,
    ],
    { DATABASE_URL: process.env.DATABASE_URL },
    (m, p) => {
      if (m === "textDocument/publishDiagnostics") diagnostics.push(p as Diagnostic);
    },
  );
  const file = join(dir, "queries.ts"),
    uri = pathToFileURL(file).href;
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }),
  );
  const source = `import {sql} from "./.inline/sql.ts"; sql.query("refresh")\`SELECT t.id FROM ${schema}.items t\``;
  const complete = () =>
    lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: position(source, source.indexOf("t.id") + 2),
    }) as Promise<{ items: { label: string; detail: string }[] }>;
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 8000;
    while (!predicate() && Date.now() < until) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  }
  const output = join(dir, "generated.ts");
  try {
    await db.unsafe(`CREATE SCHEMA ${schema}`);
    await db.unsafe(`CREATE TABLE ${schema}.items (id integer NOT NULL)`);
    await writeFile(file, source);
    await lsp.request("initialize", { rootUri: pathToFileURL(dir).href });
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, text: source, version: 1, languageId: "typescript" },
    });
    expect((await complete()).items.find((i) => i.label === "id")?.detail).toContain("integer");
    await generate([file], output);
    expect(await Bun.file(output).text()).toContain("id: number");
    await db.unsafe(
      `ALTER TABLE ${schema}.items ALTER COLUMN id TYPE text USING id::text, ADD COLUMN added boolean`,
    );
    await lsp.request("workspace/executeCommand", { command: "reylo.inline.refreshSchema" });
    const updated = await complete();
    expect(updated.items.find((i) => i.label === "id")?.detail).toContain("text");
    expect(updated.items.map((i) => i.label)).toContain("added");
    await generate([file], output);
    expect(await Bun.file(output).text()).toContain("id: string");
    const before = await Bun.file(output).text();
    diagnostics.length = 0;
    await db.unsafe(`ALTER TABLE ${schema}.items DROP COLUMN id`);
    await lsp.request("workspace/executeCommand", { command: "reylo.inline.refreshSchema" });
    expect((await complete()).items.map((i) => i.label)).not.toContain("id");
    await waitFor(() =>
      diagnostics.some(
        (d) =>
          d.uri === uri &&
          d.diagnostics.some(
            (e) => e.message.includes("id") && e.message.includes("does not exist"),
          ),
      ),
    );
    await rejects(generate([file], output));
    expect(await Bun.file(output).text()).toBe(before);
  } finally {
    await lsp.close();
    await db.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 25_000);

import { rejects } from "node:assert/strict";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { client } from "./lsp-client.ts";
import { position } from "../src/preview.ts";

test("preview LSP: split frames, UTF-16 changes, stale versions, close", async () => {
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"]);
  const uri = "file:///virtual/queries.ts";
  const source =
    '// 🌍\nimport { sql } from "../.inline/sql.ts";\nsql.query("x")`SELECT name FROM users ${sql.where(sql`id = ${id}`)}`';
  const at = position(source, source.indexOf(".query") + 2);
  try {
    expect(
      JSON.stringify(
        await lsp.request(
          "initialize",
          { capabilities: { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } },
          true,
        ),
      ),
    ).toContain('"hoverProvider":true');
    lsp.notify("initialized", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });
    const hover = () => lsp.request("textDocument/hover", { textDocument: { uri }, position: at });
    expect(JSON.stringify(await hover())).toContain("SELECT name FROM users WHERE (id = $1)");
    const start = source.indexOf("SELECT name") + 7;
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [
        {
          range: { start: position(source, start), end: position(source, start + 4) },
          text: "email",
        },
      ],
    });
    expect(JSON.stringify(await hover())).toContain("SELECT email");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 1 },
      contentChanges: [{ text: source }],
    });
    expect(JSON.stringify(await hover())).toContain("SELECT email");
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
    expect(await hover()).toBeNull();
  } finally {
    await lsp.close();
  }
}, 20_000);

test("configured TypeScript 7 LSP exposes generated SQL docs and inferred IDE types", async () => {
  const lsp = client([Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"]);
  const rootUri = pathToFileURL(resolve(".")).href;
  try {
    await lsp.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "inline" }],
      capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] } } },
    });
    lsp.notify("initialized", {});
    const opened = new Set<string>();
    const hoverFile = async (file: string, needle: string) => {
      const path = resolve(file),
        uri = pathToFileURL(path).href,
        source = await Bun.file(path).text();
      if (!opened.has(uri))
        lsp.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: source },
        });
      opened.add(uri);
      return JSON.stringify(
        await lsp.request("textDocument/hover", {
          textDocument: { uri },
          position: position(source, source.indexOf(needle)),
        }),
      );
    };
    const docs = await hoverFile("examples/queries.ts", 'query("searchUsers")');
    expect(docs).toContain("Generated preview from the last successful analysis");
    expect(docs).toContain("SELECT u.id, u.name, u.email");
    const id = await hoverFile("examples/ide-demo.ts", "userId =");
    expect(id).toContain("userId: number");
    const email = await hoverFile("examples/ide-demo.ts", "email = first");
    expect(email).toContain("string | null");
    const rank = await hoverFile("examples/ide-demo.ts", "position = ranked");
    expect(rank).toContain("bigint | undefined");
  } finally {
    await lsp.close();
  }
}, 25_000);

test("SQL diagnostics: unsaved typo, correction, stale edit, and close", async () => {
  type Publication = {
    uri: string;
    version?: number;
    diagnostics: {
      message: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }[];
  };
  const publications: Publication[] = [];
  const lsp = client(
    [process.execPath, "--no-env-file", "scripts/preview-server.ts"],
    { DATABASE_URL: process.env.DATABASE_URL },
    (method, params) => {
      if (method === "textDocument/publishDiagnostics") publications.push(params as Publication);
    },
  );
  const uri = pathToFileURL(resolve("examples/diagnostic-unsaved.ts")).href;
  const source =
    '// 🌍\nimport { sql } from "../.inline/sql.ts";\nsql.query("live")`SELECT id2 FROM reylo_inline_demo.users`';
  const waitFor = async (predicate: (p: Publication) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = publications.find(predicate);
      if (found) return found;
      await Bun.sleep(25);
    }
    throw new Error(`Missing diagnostics: ${JSON.stringify(publications)}`);
  };
  try {
    await lsp.request("initialize", {});
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: source },
    });
    const error = await waitFor(
      (p) => p.version === 1 && p.diagnostics.some((d) => d.message.includes("id2")),
    );
    expect(error.diagnostics[0]!.range.start).toEqual(position(source, source.indexOf("id2")));
    const good = source.replace("SELECT id2", "SELECT id");
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: good }],
    });
    await waitFor((p) => p.version === 2 && !p.diagnostics.length);
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: source }],
    });
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 4 },
      contentChanges: [{ text: good }],
    });
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: source }],
    });
    await Bun.sleep(650);
    expect(publications.some((p) => (p.version ?? 0) >= 2 && p.diagnostics.length)).toBe(false);
    // An independent database check completed, not only the eager clear on edit.
    expect(
      publications.filter((p) => p.version === 4 && !p.diagnostics.length).length,
    ).toBeGreaterThanOrEqual(2);
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
    await waitFor((p) => p.version === undefined && !p.diagnostics.length);
  } finally {
    await lsp.close();
  }
}, 20_000);

test("SQL completion LSP uses the database catalog and precise unsaved text edits", async () => {
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = pathToFileURL(resolve("examples/completion-unsaved.ts")).href;
  const preamble = '// 🌍\nimport {sql} from "../.inline/sql.ts";\n';
  let version = 0;
  const ask = async (sql: string) => {
    const marked = preamble + 'sql.query("complete")`' + sql + "`";
    const at = marked.indexOf("▌"),
      source = marked.replace("▌", "");
    if (++version === 1)
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri, version, languageId: "typescript", text: source },
      });
    else
      lsp.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: source }],
      });
    return (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: position(source, at),
    })) as {
      items: {
        label: string;
        detail: string;
        textEdit: {
          newText: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        };
      }[];
    };
  };
  try {
    expect(JSON.stringify(await lsp.request("initialize", {}))).toContain('"completionProvider"');
    const columns = await ask("SELECT u.▌ FROM reylo_inline_demo.users u");
    const email = columns.items.find((i) => i.label === "email");
    expect(email?.detail).toContain("text");
    expect(email?.textEdit.newText).toBe("email");
    expect(email?.textEdit.range.start).toEqual(email?.textEdit.range.end);
    const table = await ask("SELECT * FROM reylo_inline_demo.us▌");
    expect(table.items.find((i) => i.label === "users")?.textEdit.newText).toBe("users");
    const js = await ask("SELECT id FROM reylo_inline_demo.users WHERE id = ${org▌Id}");
    expect(js.items).toEqual([]);
  } finally {
    await lsp.close();
  }
}, 20_000);

test("advanced SQL completion and signature help use live PostgreSQL metadata", async () => {
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = pathToFileURL(resolve("examples/advanced-completion-unsaved.ts")).href;
  let version = 0;
  const ask = async (sql: string, method = "textDocument/completion") => {
    const marked = 'import {sql} from "../.inline/sql.ts"; sql.query("advanced")`' + sql + "`";
    const cursor = marked.indexOf("▌"),
      text = marked.replace("▌", "");
    if (++version === 1)
      lsp.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "typescript", version, text },
      });
    else
      lsp.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    return (await lsp.request(method, {
      textDocument: { uri },
      position: position(text, cursor),
    })) as {
      items: { label: string; detail: string }[];
      signatures: { label: string }[];
      activeParameter: number;
    };
  };
  try {
    expect(JSON.stringify(await lsp.request("initialize", {}))).toContain("signatureHelpProvider");
    const cte = await ask(
      "WITH recent AS (SELECT id, name AS display_name FROM reylo_inline_demo.users) SELECT r.▌ FROM recent r",
    );
    expect(cte.items.map((i) => i.label)).toEqual(["id", "display_name"]);
    const sub = await ask(
      "SELECT s.▌ FROM (SELECT id, name AS display_name FROM reylo_inline_demo.users) s",
    );
    expect(sub.items.map((i) => i.label)).toEqual(["id", "display_name"]);
    const fn = await ask("SELECT item.▌ FROM jsonb_each($1::jsonb) item");
    expect(fn.items.map((i) => i.label)).toEqual(["key", "value"]);
    expect(fn.items.find((i) => i.label === "value")!.detail).toContain("jsonb");
    const excluded = await ask(
      "INSERT INTO reylo_inline_demo.users(id,org_id,name) VALUES (1,10,$1) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.na▌",
    );
    expect(excluded.items.map((i) => i.label)).toEqual(["name"]);
    const hover = await ask(
      "SELECT low▌er(name) FROM reylo_inline_demo.users",
      "textDocument/hover",
    );
    expect(JSON.stringify(hover)).toContain("pg_catalog.lower(text)");
    const sig = await ask(
      "SELECT lower(▌name) FROM reylo_inline_demo.users",
      "textDocument/signatureHelp",
    );
    expect(sig.signatures.some((s) => s.label === "pg_catalog.lower(text) → text")).toBe(true);
    expect(sig.activeParameter).toBe(0);
    const none = await ask("SELECT ${org▌Id}", "textDocument/signatureHelp");
    expect(none).toBeNull();
  } finally {
    await lsp.close();
  }
}, 20_000);

test("completion cancellation and newer document versions suppress stale results; SQL colors use LSP", async () => {
  const lsp = client([process.execPath, "--no-env-file", "scripts/preview-server.ts"], {
    DATABASE_URL: process.env.DATABASE_URL,
  });
  const uri = "file:///virtual/cancellation.ts";
  const source =
    'import {sql} from "../.inline/sql.ts"; sql.query("x")`SELECT u. FROM reylo_inline_demo.users u`';
  const at = position(source, source.indexOf("u.") + 2);
  try {
    const init = await lsp.request("initialize", {});
    expect(JSON.stringify(init)).toContain("semanticTokensProvider");
    lsp.notify("textDocument/didOpen", { textDocument: { uri, text: source, version: 1 } });
    // Request 2 awaits the first catalog worker; cancel before its result arrives.
    const cancelled = lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: at,
    });
    lsp.notify("$/cancelRequest", { id: 2 });
    const stale = lsp.request("textDocument/completion", { textDocument: { uri }, position: at });
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: source.replace("users u", "users changed") }],
    });
    await rejects(cancelled, /Request cancelled/);
    const result = (await stale) as { items: unknown[]; isIncomplete: boolean };
    expect(result).toEqual({ items: [], isIncomplete: true });
    const current = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: at,
    })) as { items: unknown[] };
    expect(current.items).toEqual([]);
    const colors = (await lsp.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })) as { data: number[] };
    expect(colors.data.length).toBeGreaterThan(0);
    lsp.notify("textDocument/didClose", { textDocument: { uri } });
    expect(
      await lsp.request("textDocument/semanticTokens/full", { textDocument: { uri } }),
    ).toEqual({ data: [] });
  } finally {
    await lsp.close();
  }
}, 15_000);

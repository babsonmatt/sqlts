#!/usr/bin/env bun
import { DependencyWatch } from "../src/sqlts/dependency-watch.ts";
import { schemaSignal } from "../src/sqlts/schema-refresh.ts";
import { CallPreviewService } from "../src/call-preview.ts";
import { resolve } from "node:path";
import { SqlSemanticTokens, tokenTypes } from "../src/semantic-tokens.ts";
import { SqltsSemanticTokens } from "../src/sqlts/semantic-tokens.ts";
import { CatalogService } from "../src/catalog-service.ts";
import { CompletionService } from "../src/completion.ts";
import { DiagnosticScheduler } from "../src/diagnostic-scheduler.ts";
import { PreviewService, offset, type Position, type Range } from "../src/preview.ts";

const projectIndex = process.argv.indexOf("--project");
const projectRoot = resolve(projectIndex >= 0 ? (process.argv[projectIndex + 1] ?? ".") : ".");

interface Request {
  id?: string | number;
  method: string;
  params?: {
    capabilities?: { workspace?: { didChangeWatchedFiles?: { dynamicRegistration?: boolean } } };
    id?: string | number;
    command?: string;
    changes?: { uri: string; type: number }[];
    textDocument?: { uri: string; text: string; version: number };
    position?: Position;
    contentChanges?: { range?: Range; text: string }[];
  };
}
const service = new PreviewService();
const calls = new CallPreviewService();
const completion = new CompletionService();
const colors = new SqlSemanticTokens();
const sqltsColors = new SqltsSemanticTokens();
const isSqlts = (uri: string) => uri.endsWith(".sqlts");
const hasSql = (uri: string, text: string) =>
  isSqlts(uri) ? text.includes("@sqlts/core") : text.includes(".inline/sql");
const catalog = new CatalogService(
  () =>
    send({
      jsonrpc: "2.0",
      method: "window/logMessage",
      params: {
        type: 2,
        message:
          "SQL completion catalog unavailable. Check the development database configuration.",
      },
    }),
  { projectRoot, changed: () => recheckDocuments() },
);
const schemaWatch = new DependencyWatch(() => {
  void catalog.refresh().then(recheckDocuments);
});
schemaWatch.update([schemaSignal(projectRoot)]);
process.on("exit", () => schemaWatch.close());
const versions = new Map<string, number>();
let shutdown = false;
let watchFiles = false;
const diagnostics = new DiagnosticScheduler(
  (uri) => versions.get(uri),
  (uri, version, diagnostics) =>
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version, diagnostics },
    }),
  projectRoot,
);
function recheckDocuments() {
  for (const [uri, text] of service.documents) {
    const version = versions.get(uri);
    if (version !== undefined && !isSqlts(uri)) diagnostics.schedule(uri, text, version);
  }
}
const pending = new Map<string | number, { cancelled: boolean }>();
function send(value: unknown) {
  const body = JSON.stringify(value);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(request: Request): unknown {
  const p = request.params;
  const doc = p?.textDocument;
  switch (request.method) {
    case "initialize":
      watchFiles = p?.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
      return {
        capabilities: {
          positionEncoding: "utf-16",
          textDocumentSync: { openClose: true, change: 2, save: true },
          hoverProvider: true,
          semanticTokensProvider: { legend: { tokenTypes, tokenModifiers: [] }, full: true },
          executeCommandProvider: { commands: ["reylo.inline.refreshSchema"] },
          signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
          completionProvider: { triggerCharacters: [".", " "], resolveProvider: false },
        },
        serverInfo: { name: "Reylo Inline SQL Preview", version: "0.2.0" },
      };
    case "initialized":
      if (watchFiles)
        send({
          jsonrpc: "2.0",
          id: "schema-watch-registration",
          method: "client/registerCapability",
          params: {
            registrations: [
              {
                id: "schema-files",
                method: "workspace/didChangeWatchedFiles",
                registerOptions: {
                  watchers: [
                    { globPattern: "**/*.sql" },
                    { globPattern: "**/.reylo.{yaml,yml}" },
                    { globPattern: "**/.env" },
                  ],
                },
              },
            ],
          },
        });
      return;
    case "$/cancelRequest": {
      const state = p?.id !== undefined ? pending.get(p.id) : undefined;
      if (state) state.cancelled = true;
      return;
    }
    case "workspace/didChangeWatchedFiles":
      if (p?.changes?.some((c) => /(?:\.(sql|ya?ml)|\/\.env)$/.test(c.uri)))
        void catalog.refresh().then(recheckDocuments);
      return;
    case "workspace/executeCommand":
      if (p?.command === "reylo.inline.refreshSchema")
        return catalog.refresh().then(() => {
          recheckDocuments();
          return null;
        });
      return null;
    case "shutdown":
      shutdown = true;
      schemaWatch.close();
      diagnostics.stop();
      catalog.stop();
      return null;
    case "exit":
      process.exit(shutdown ? 0 : 1);
      break;
    case "textDocument/didOpen":
      if (doc && doc.text.length <= 500_000 && service.documents.size < 64) {
        service.documents.set(doc.uri, doc.text);
        versions.set(doc.uri, doc.version);
        if (!isSqlts(doc.uri)) diagnostics.schedule(doc.uri, doc.text, doc.version);
        if (hasSql(doc.uri, doc.text)) void catalog.get();
      }
      return;
    case "textDocument/didChange": {
      if (!doc || doc.version <= (versions.get(doc.uri) ?? -1)) return;
      let text = service.documents.get(doc.uri);
      if (text === undefined) return;
      for (const change of p?.contentChanges ?? []) {
        text = change.range
          ? text.slice(0, offset(text, change.range.start)) +
            change.text +
            text.slice(offset(text, change.range.end))
          : change.text;
      }
      versions.set(doc.uri, doc.version);
      if (text.length <= 500_000) {
        service.documents.set(doc.uri, text);
        if (!isSqlts(doc.uri)) diagnostics.schedule(doc.uri, text, doc.version);
      } else {
        service.close(doc.uri);
        calls.close(doc.uri);
        completion.close(doc.uri);
        colors.close(doc.uri);
        sqltsColors.close(doc.uri);
        versions.delete(doc.uri);
        diagnostics.close(doc.uri);
      }
      return;
    }
    case "textDocument/didSave": {
      if (doc) {
        const text = service.documents.get(doc.uri);
        const version = versions.get(doc.uri);
        if (text !== undefined && version !== undefined && !isSqlts(doc.uri))
          diagnostics.schedule(doc.uri, text, version);
        if (text !== undefined && hasSql(doc.uri, text)) void catalog.refresh();
      }
      return;
    }
    case "textDocument/didClose":
      if (doc) {
        service.close(doc.uri);
        calls.close(doc.uri);
        completion.close(doc.uri);
        colors.close(doc.uri);
        sqltsColors.close(doc.uri);
        versions.delete(doc.uri);
        diagnostics.close(doc.uri);
      }
      return;
    case "textDocument/signatureHelp":
    case "textDocument/completion": {
      const text = doc && service.documents.get(doc.uri);
      const at = p?.position;
      if (!doc || text === undefined || !at || !hasSql(doc.uri, text))
        return request.method === "textDocument/signatureHelp"
          ? null
          : { isIncomplete: false, items: [] };
      const version = versions.get(doc.uri);
      return catalog
        .get()
        .then((schema) =>
          service.documents.get(doc.uri) === text &&
          versions.get(doc.uri) === version &&
          !pending.get(request.id!)?.cancelled
            ? request.method === "textDocument/signatureHelp"
              ? completion.signatureHelp(text, doc.uri, at, schema)
              : completion.complete(text, doc.uri, at, schema)
            : request.method === "textDocument/signatureHelp"
              ? null
              : { isIncomplete: true, items: [] },
        );
    }
    case "textDocument/semanticTokens/full": {
      const text = doc && service.documents.get(doc.uri);
      return doc && text !== undefined
        ? (isSqlts(doc.uri) ? sqltsColors : colors).full(text, doc.uri)
        : { data: [] };
    }
    case "textDocument/hover": {
      if (!doc || !p?.position) return null;
      const text = service.documents.get(doc.uri);
      return (
        calls.hover(doc.uri, p.position, service.documents) ??
        (text !== undefined
          ? completion.functionHover(text, doc.uri, p.position, catalog.peek())
          : null) ??
        (isSqlts(doc.uri) ? null : service.hover(doc.uri, p.position))
      );
    }
    default:
      return null;
  }
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 8_000_000) process.exit(1);
  for (;;) {
    const separator = input.indexOf("\r\n\r\n");
    if (separator < 0) break;
    const size = /^Content-Length:\s*(\d+)\s*$/im.exec(
      input.subarray(0, separator).toString("ascii"),
    );
    if (!size || Number(size[1]) > 8_000_000) process.exit(1);
    const end = separator + 4 + Number(size[1]);
    if (input.length < end) break;
    const body = input.subarray(separator + 4, end).toString("utf8");
    input = input.subarray(end);
    let request: Request | undefined;
    try {
      request = JSON.parse(body) as Request;
      if (!request.method) continue; // Client response to capability registration.
      const state = { cancelled: false };
      if (request.id !== undefined) pending.set(request.id, state);
      const result = handle(request);
      if (request.id !== undefined) {
        const id = request.id;
        void Promise.resolve(result).then(
          (result) => {
            pending.delete(id);
            send(
              state.cancelled
                ? { jsonrpc: "2.0", id, error: { code: -32800, message: "Request cancelled" } }
                : { jsonrpc: "2.0", id, result: result ?? null },
            );
          },
          () => {
            pending.delete(id);
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: "Language server request failed" },
            });
          },
        );
      }
    } catch (error) {
      if (request?.id !== undefined)
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error) } });
    }
  }
});

process.stdin.on("end", () => {
  diagnostics.stop();
  catalog.stop();
  process.exit(0);
});

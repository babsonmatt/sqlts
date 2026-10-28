import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { AutoEditor, tokenTypes } from "../src/auto/editor.ts";
import { defaultProject } from "../src/auto/project.ts";
import { offset, type Position, type Range } from "../src/preview.ts";
const projectAt = process.argv.indexOf("--project");
const root = projectAt >= 0 ? resolve(process.argv[projectAt + 1] ?? ".") : defaultProject;
function send(message: unknown) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const versions = new Map<string, number>();
const editor = new AutoEditor(root, (file, diagnostics) =>
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: pathToFileURL(file).href, version: versions.get(file), diagnostics },
  }),
);
type Message = {
  id?: string | number;
  method?: string;
  params?: {
    id?: string | number;
    textDocument?: { uri: string; text: string; version: number };
    position?: Position;
    contentChanges?: { range?: Range; text: string }[];
  };
};
const cancelled = new Set<string | number>();
const pending = new Set<string | number>();
async function handle(message: Message): Promise<unknown> {
  const p = message.params,
    doc = p?.textDocument;
  let file: string | undefined;
  if (doc?.uri.startsWith("file:")) {
    try {
      file = fileURLToPath(doc.uri);
    } catch {
      return null;
    }
  }
  switch (message.method) {
    case "initialize":
      return {
        capabilities: {
          positionEncoding: "utf-16",
          textDocumentSync: { openClose: true, change: 2, save: true },
          hoverProvider: true,
          definitionProvider: true,
          completionProvider: { triggerCharacters: ["."], resolveProvider: false },
          semanticTokensProvider: { legend: { tokenTypes, tokenModifiers: [] }, full: true },
        },
        serverInfo: { name: "Reylo Auto Experiment", version: "0.1.0" },
      };
    case "shutdown":
      await editor.stop();
      return null;
    case "exit":
      await editor.stop();
      process.exit(0);
      break;
    case "$/cancelRequest":
      if (p?.id !== undefined && pending.has(p.id)) cancelled.add(p.id);
      return;
    case "textDocument/didOpen":
      if (file && doc) {
        versions.set(file, doc.version);
        editor.update(file, doc.text);
      }
      return;
    case "textDocument/didChange": {
      if (!file || !doc || doc.version <= (versions.get(file) ?? -1)) return;
      let text = editor.documents.get(file);
      if (text === undefined) return;
      for (const change of p?.contentChanges ?? [])
        text = change.range
          ? text.slice(0, offset(text, change.range.start)) +
            change.text +
            text.slice(offset(text, change.range.end))
          : change.text;
      versions.set(file, doc.version);
      editor.update(file, text);
      return;
    }
    case "textDocument/didClose":
      if (file) {
        versions.delete(file);
        editor.close(file);
      }
      return;
    case "textDocument/didSave":
      if (file && editor.documents.has(file)) editor.update(file, editor.documents.get(file)!);
      return;
    case "textDocument/hover":
      return file && p?.position ? editor.hover(file, p.position) : null;
    case "textDocument/completion":
      return file && p?.position
        ? editor.complete(file, p.position)
        : { items: [], isIncomplete: false };
    case "textDocument/definition":
      return file && p?.position
        ? (await editor.definition(file, p.position))?.map((d) => ({
            uri: pathToFileURL(d.file).href,
            range: d.range,
          }))
        : null;
    case "textDocument/semanticTokens/full":
      return file ? editor.semantic(file) : { data: [] };
    default:
      return null;
  }
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 8_000_000) process.exit(1);
  for (;;) {
    const header = input.indexOf("\r\n\r\n");
    if (header < 0) break;
    const length = /Content-Length:\s*(\d+)/i.exec(input.subarray(0, header).toString())?.[1];
    if (!length || Number(length) > 8_000_000) process.exit(1);
    const end = header + 4 + Number(length);
    if (input.length < end) break;
    const message = JSON.parse(input.subarray(header + 4, end).toString()) as Message;
    input = input.subarray(end);
    if (!message.method) continue;
    if (message.id !== undefined) pending.add(message.id);
    const requestVersions = new Map(versions);
    void handle(message).then(
      (result) => {
        if (message.id === undefined) return;
        pending.delete(message.id);
        const stale = [...requestVersions].some(
          ([file, version]) => versions.get(file) !== version,
        );
        const wasCancelled = cancelled.delete(message.id);
        send(
          wasCancelled
            ? {
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32800, message: "Request cancelled" },
              }
            : { jsonrpc: "2.0", id: message.id, result: stale ? null : (result ?? null) },
        );
      },
      () => {
        if (message.id !== undefined) {
          pending.delete(message.id);
          cancelled.delete(message.id);
        }
        if (message.id !== undefined)
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "Auto experiment request failed" },
          });
      },
    );
  }
});
process.stdin.on("end", () => void editor.stop().finally(() => process.exit(0)));

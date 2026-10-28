import { fileURLToPath } from "node:url";
import { SqltsSemanticTokens, tokenTypes } from "./semantic-tokens.ts";
import { offset, type Range } from "../preview.ts";

interface Message {
  id?: number | string;
  method?: string;
  params?: {
    textDocument?: { uri: string; text: string; version: number };
    contentChanges?: { range?: Range; text: string }[];
  };
}
const colors = new SqltsSemanticTokens();
const documents = new Map<string, { text: string; version: number }>();
let shutdown = false;
function send(value: unknown) {
  const body = JSON.stringify(value);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function handle(message: Message): unknown {
  const doc = message.params?.textDocument;
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
          textDocumentSync: { openClose: true, change: 2 },
          semanticTokensProvider: { legend: { tokenTypes, tokenModifiers: [] }, full: true },
        },
        serverInfo: { name: "Reylo SQLTS Highlighting", version: "0.1.0" },
      };
    case "shutdown":
      shutdown = true;
      documents.clear();
      return null;
    case "exit":
      process.exit(shutdown ? 0 : 1);
      break;
    case "textDocument/didOpen":
      if (file?.endsWith(".sqlts") && doc && doc.text.length <= 500_000 && documents.size < 64)
        documents.set(file, { text: doc.text, version: doc.version });
      return;
    case "textDocument/didChange": {
      const current = file && documents.get(file);
      if (!file || !doc || !current || doc.version <= current.version) return;
      let text = current.text;
      for (const change of message.params?.contentChanges ?? [])
        text = change.range
          ? text.slice(0, offset(text, change.range.start)) +
            change.text +
            text.slice(offset(text, change.range.end))
          : change.text;
      if (text.length > 500_000) {
        documents.delete(file);
        colors.close(file);
      } else documents.set(file, { text, version: doc.version });
      return;
    }
    case "textDocument/didClose":
      if (file) {
        documents.delete(file);
        colors.close(file);
      }
      return;
    case "textDocument/semanticTokens/full": {
      const current = file && documents.get(file);
      return file && current ? colors.full(current.text, file) : { data: [] };
    }
    default:
      return null;
  }
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 4_000_000) process.exit(1);
  for (;;) {
    const boundary = input.indexOf("\r\n\r\n");
    if (boundary < 0) break;
    const length = /Content-Length:\s*(\d+)/i.exec(input.subarray(0, boundary).toString())?.[1];
    if (!length || Number(length) > 4_000_000) process.exit(1);
    const end = boundary + 4 + Number(length);
    if (input.length < end) break;
    const body = input.subarray(boundary + 4, end).toString();
    input = input.subarray(end);
    let message: Message;
    try {
      message = JSON.parse(body) as Message;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    try {
      const result = handle(message);
      if (message.id !== undefined)
        send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
    } catch {
      if (message.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: "Highlighting request failed" },
        });
    }
  }
});
process.stdin.on("end", () => process.exit(0));

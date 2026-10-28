import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Editor workers run on whichever runtime started the server. Neither runtime may load the
 * application's preload hooks; both load the project's .env files for database settings.
 */
function args(script: string) {
  return typeof Bun !== "undefined"
    ? [`--config=${resolve(codeRoot, "editors/zed/server.bunfig.toml")}`, script]
    : ["--env-file-if-exists=.env", "--env-file-if-exists=.env.local", script];
}

export interface Worker {
  child: ChildProcess;
  result: Promise<{ code: number | null; stdout: string }>;
}

export function runWorker(script: string, cwd: string, input?: string): Worker {
  const child = spawn(process.execPath, args(script), {
    cwd,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
  });
  const result = new Promise<{ code: number | null; stdout: string }>((done, fail) => {
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
  if (input !== undefined) child.stdin!.end(input);
  return { child, result };
}

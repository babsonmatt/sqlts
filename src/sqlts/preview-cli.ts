#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The server runs on Node unless `--runtime bun` is passed. Its workers use the same runtime.
// Editor startup must not execute the consumer application's preload hooks; the workers
// separately read the selected project's database settings.
const server = fileURLToPath(new URL("../../scripts/preview-server.ts", import.meta.url));
const args = process.argv.slice(2);
const flag = args.indexOf("--runtime");
const runtime = flag < 0 ? undefined : args.splice(flag, 2)[1];
if (runtime !== undefined && runtime !== "node" && runtime !== "bun") {
  console.error("SQLTS preview: --runtime must be node or bun");
  process.exit(1);
}
// A source checkout's TypeScript needs Bun; the published package is compiled JavaScript.
const bun = runtime === "bun" || server.endsWith(".ts");
const env = { ...process.env };
delete env.NODE_OPTIONS;
const child = spawn(
  bun ? "bun" : process.execPath,
  bun
    ? [
        "--no-env-file",
        `--config=${fileURLToPath(new URL("../../editors/zed/server.bunfig.toml", import.meta.url))}`,
        server,
        ...args,
      ]
    : [server, ...args],
  { stdio: "inherit", env },
);
child.on("error", (error) => {
  console.error(
    bun
      ? `SQLTS preview: --runtime bun needs Bun on PATH (${error.message})`
      : `SQLTS preview could not start: ${error.message}`,
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));

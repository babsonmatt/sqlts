#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Editor startup must not execute the consumer application's Bun preload hooks.
// The catalog worker separately reads the selected project's database settings.
const child = spawn(
  "bun",
  [
    "--no-env-file",
    `--config=${fileURLToPath(new URL("../../editors/zed/server.bunfig.toml", import.meta.url))}`,
    fileURLToPath(new URL("../../scripts/preview-server.ts", import.meta.url)),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
child.on("error", () => {
  console.error("SQLTS preview requires Bun on PATH.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));

#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
if (command === "check") {
  const require = createRequire(resolve("package.json"));
  const compiler = resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "--noEmit", "--runExternalCode", ...args], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (command === "refresh-schema" && args.length === 2 && args[0] === "--project") {
  const { refreshSchema } = await import("./schema-refresh.ts");
  refreshSchema(args[1]!);
  console.log("SQLTS schema refresh signaled. Run a fresh SQL-aware check to verify queries.");
} else if (command === "build" && args.length === 2) {
  const { buildSqlts } = await import("./build.ts");
  console.log(await buildSqlts(args[0]!, args[1]!));
} else {
  console.error(
    "Usage: sqlts check -p tsconfig.json\n       sqlts refresh-schema --project directory\n       bun sqlts build entry.ts output.mjs",
  );
  process.exitCode = 1;
}

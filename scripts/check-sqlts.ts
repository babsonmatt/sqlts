import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
// Oxc/Bun's built-in checker cannot execute content mappers. Check these projects
// through the native SQL-aware compiler instead of accepting untyped module shims.
for (const item of await readdir("experiments", { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  const file = resolve("experiments", item.name, "tsconfig.json");
  let config: { contentMappers?: { package?: string }[] };
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    continue;
  }
  if (!config.contentMappers?.some((m) => m.package === "reylo-sqlts-experiment")) continue;
  console.log(`SQLTS checking ${item.name}`);
  const p = Bun.spawn(
    ["node", "node_modules/typescript/bin/tsc", "--noEmit", "--runExternalCode", "-p", file],
    { stdout: "inherit", stderr: "inherit" },
  );
  const code = await p.exited;
  if (code) process.exit(code);
}

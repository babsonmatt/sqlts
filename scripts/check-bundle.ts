import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
await mkdir("work", { recursive: true });
const directory = await mkdtemp(resolve("work/standalone-"));
try {
  const built = await Bun.build({
    entrypoints: ["examples/demo.ts"],
    target: "bun",
    outdir: directory,
  });
  assert(built.success, built.logs.map(String).join("\n"));
  const output = built.outputs[0]!;
  const text = await output.text();
  for (const forbidden of [
    "@reylosql/postgres",
    "typescript-ast",
    "engine.wasm",
    "createSourceFile",
  ]) {
    assert(!text.includes(forbidden), `Analysis dependency leaked into bundle: ${forbidden}`);
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", output.path], {
    cwd: directory,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assert.equal(code, 0, stderr);
  assert(stdout.includes("Raw inline AND fragments") && stdout.includes("alice@example.test"));
  console.log(
    `Standalone demo passed; ${output.size} byte bundle; no analysis engine or TypeScript parser.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

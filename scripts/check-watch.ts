import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
const originalArtifact = await readFile(".inline/sql.ts", "utf8");
const directory = `examples/watch-${crypto.randomUUID()}`;
const file = `${directory}/queries.ts`;
const child = Bun.spawn([process.execPath, "scripts/watch.ts"], { stdout: "pipe", stderr: "pipe" });
let output = "";
const readers = [child.stdout, child.stderr].map(async (stream) => {
  for await (const chunk of stream) output += new TextDecoder().decode(chunk);
});
async function waitFor(needle: string, from = 0) {
  const deadline = performance.now() + 15_000;
  while (!output.slice(from).includes(needle)) {
    if (performance.now() > deadline || child.exitCode !== null)
      throw new Error(`Watcher did not report ${needle}: ${output}`);
    await Bun.sleep(25);
  }
}
try {
  await waitFor("Types updated.");
  await mkdir(directory);
  let from = output.length;
  await writeFile(
    file,
    'import { sql } from "../../.inline/sql.ts";\nexport const q = sql.query("watchFixture")`SELECT id FROM reylo_inline_demo.users`;\n',
  );
  await waitFor("Types updated.", from);
  const good = await Bun.file(".inline/sql.ts").text();
  assert(good.includes("watchFixture"));
  from = output.length;
  await writeFile(
    file,
    'import { sql } from "../../.inline/sql.ts";\nexport const q = sql.query("watchFixture")`SELECT missing_column FROM reylo_inline_demo.users`;\n',
  );
  await waitFor("Generation failed", from);
  assert.equal(await Bun.file(".inline/sql.ts").text(), good);
  from = output.length;
  await rm(directory, { recursive: true });
  await waitFor("Types updated.", from);
  assert(!(await Bun.file(".inline/sql.ts").text()).includes("watchFixture"));
  console.log(
    "Watcher passed: added query, invalid edit retains good types, deletion regenerates.",
  );
} finally {
  child.kill();
  await child.exited;
  await Promise.all(readers);
  await rm(directory, { recursive: true, force: true });
  await writeFile(".inline/sql.ts", originalArtifact);
}

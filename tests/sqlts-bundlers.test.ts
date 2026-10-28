import { rejects } from "node:assert/strict";
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { build as viteBuild, createServer } from "vite";
import esbuildSqlts from "../src/sqlts/esbuild.ts";
import viteSqlts from "../src/sqlts/vite.ts";
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-bundlers-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
await writeFile(
  resolve(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      module: "preserve",
      moduleResolution: "bundler",
      target: "esnext",
      skipLibCheck: true,
    },
    contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
  }),
);
await writeFile(
  resolve(dir, "fragments.sqlts"),
  `import {sql} from '@sqlts/core';export const present=sql.fragment\`id > 0\`;`,
);
await writeFile(
  resolve(dir, "queries.sqlts"),
  `import {sql} from '@sqlts/core';import {present} from './fragments.sqlts';export function users(){return sql\`SELECT id,name FROM reylo_inline_demo.users \${sql.where(present)} ORDER BY id\`;}`,
);
await writeFile(
  resolve(dir, "entry.ts"),
  `import {users} from './queries.sqlts';import {Pool} from 'pg';const db=new Pool({connectionString:process.env.DATABASE_URL});try{const rows=await users().run(db);if(!rows.length)throw Error('missing rows');console.log('bundle executed');}finally{await db.end();}`,
);
async function execute(file: string) {
  const p = Bun.spawn(["node", "--env-file=.env", file], { stdout: "pipe", stderr: "pipe" });
  const [code, a, b] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  expect(code, a + b).toBe(0);
  expect(a).toContain("bundle executed");
}
test("esbuild and Vite SSR execute runtime-only bundles", async () => {
  const esfile = resolve(dir, "esbuild.mjs");
  const result = await build({
    entryPoints: [resolve(dir, "entry.ts")],
    outfile: esfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    metafile: true,
    plugins: [esbuildSqlts()],
  });
  expect(Object.keys(result.metafile!.inputs).some((f) => f.endsWith(".sqlts"))).toBe(true);
  expect(await Bun.file(esfile).text()).not.toContain("mapperHandlers");
  await execute(esfile);
  const dist = resolve(dir, "vite");
  await viteBuild({
    configFile: false,
    root: dir,
    plugins: [viteSqlts()],
    logLevel: "silent",
    build: {
      ssr: resolve(dir, "entry.ts"),
      outDir: dist,
      rolldownOptions: { output: { entryFileNames: "entry.mjs" } },
    },
  });
  expect(await Bun.file(resolve(dist, "entry.mjs")).text()).not.toContain("mapperHandlers");
  await execute(resolve(dist, "entry.mjs"));
}, 20_000);
test("Vite SSR reloads shared fragments; client bundles are rejected", async () => {
  const server = await createServer({
    configFile: false,
    root: dir,
    plugins: [viteSqlts()],
    logLevel: "silent",
    server: { middlewareMode: true },
    ssr: { external: ["reylo"] },
  });
  try {
    const first = await server.ssrLoadModule("/queries.sqlts");
    expect(first.users().compile().text).toContain("id > 0");
    await writeFile(
      resolve(dir, "fragments.sqlts"),
      `import {sql} from '@sqlts/core';export const present=sql.fragment\`id > 1\`;`,
    );
    server.watcher.emit("change", resolve(dir, "fragments.sqlts"));
    let updated = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (
        (await server.ssrLoadModule("/queries.sqlts")).users().compile().text.includes("id > 1")
      ) {
        updated = true;
        break;
      }
    }
    expect(updated).toBe(true);
    await rejects(server.transformRequest("/queries.sqlts"), /server\/SSR/);
  } finally {
    await server.close();
  }
}, 20_000);

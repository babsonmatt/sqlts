import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
/** Read-only database fixture: 48 consumers, four independent diamond-shaped helper graphs. */
export async function stressFixture(dir: string) {
  const leafSource =
    'import {sql} from "@sqlts/core";export function gate(enabled=false){return sql.fragment`${enabled ? sql.fragment`u.email IS NOT NULL` : sql.empty}`;}';
  const leaves: string[] = [];
  for (let group = 0; group < 4; group++) {
    const folder = resolve(dir, `g${group}`);
    await mkdir(folder, { recursive: true });
    const leaf = resolve(folder, "leaf.sqlts");
    leaves.push(leaf);
    await writeFile(leaf, leafSource);
    for (let depth = 3; depth >= 0; depth--)
      await writeFile(
        resolve(folder, `level${depth}.sqlts`),
        `import {gate as next} from "./${depth === 3 ? "leaf" : `level${depth + 1}`}.sqlts";export function gate(enabled:boolean){return next(enabled);}`,
      );
    await writeFile(
      resolve(folder, "left.sqlts"),
      'import {gate as next} from "./level0.sqlts";export const gate=(enabled:boolean)=>next(enabled);',
    );
    await writeFile(
      resolve(folder, "right.sqlts"),
      'import {gate as next} from "./level0.sqlts";export const gate=(enabled:boolean)=>next(enabled);',
    );
    await writeFile(
      resolve(folder, "both.sqlts"),
      'import {sql} from "@sqlts/core";import {gate as left} from "./left.sqlts";import {gate as right} from "./right.sqlts";export function filters(a:boolean,b:boolean){return sql.fragment`${sql.where(left(a),right(b))}`;}',
    );
  }
  const files = Array.from({ length: 48 }, (_, i) => ({
    file: resolve(dir, `query${i}.sqlts`),
    source: `import {sql} from "@sqlts/core";import {filters} from "./g${i % 4}/both.sqlts";
export const users=(a=false,b=false)=>sql\`SELECT u.id,u.email FROM reylo_inline_demo.users u \${filters(a,b)} ORDER BY u.id\`;
export const names=(a=false,b=false)=>sql\`SELECT u.id,u.name,u.email FROM reylo_inline_demo.users u \${filters(a,b)} ORDER BY u.id\`;`,
  }));
  for (const f of files) await writeFile(f.file, f.source);
  const caller =
    files.map((_, i) => `import {users as q${i}} from "./query${i}.sqlts";`).join("\n") +
    '\nimport type {PostgresClient} from "reylo";export async function check(db:PostgresClient,flag:boolean){\n' +
    files
      .map(
        (_, i) => `const a${i}:string|undefined=(await q${i}(true,false).run(db))[0]?.email;
const b${i}:string|undefined=(await q${i}(false,true).run(db))[0]?.email;
// @ts-expect-error both disabled retains null
const c${i}:string|undefined=(await q${i}(false,false).run(db))[0]?.email;
// @ts-expect-error unknown argument retains null
const d${i}:string|undefined=(await q${i}(flag,false).run(db))[0]?.email;`,
      )
      .join("\n") +
    "\n}";
  await writeFile(resolve(dir, "caller.ts"), caller);
  const config = resolve(dir, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        noUncheckedIndexedAccess: true,
        types: ["node"],
      },
      contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
      files: ["caller.ts"],
    }),
  );
  return { files, leaves, leafSource, config };
}

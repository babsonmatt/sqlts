import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { prepare } from "../src/sqlts/transform.ts";

const source = `import {sql} from "@sqlts/core";
export function joined(enabled:boolean){return sql\`
SELECT u.id, \${enabled ? sql\`peer.email\` : sql\`NULL::text\`} AS peer_email
FROM reylo_inline_demo.users u
\${enabled ? sql\`LEFT JOIN reylo_inline_demo.users peer ON peer.id=u.id+1\` : sql.empty}
ORDER BY u.id\`;}
export function complementary(enabled:boolean){return sql\`SELECT u.id,u.email FROM reylo_inline_demo.users u
\${sql.where(enabled && sql\`u.email IS NOT NULL\`, !enabled && sql\`u.email IS NOT NULL\`)} ORDER BY u.id\`;}
`;
test("linked stable guards discard impossible join/select combinations without trusting mutated guards", async () => {
  const dir = await mkdtemp(resolve("work/sqlts-linked-")),
    file = resolve(dir, "queries.sqlts");
  try {
    await writeFile(
      resolve(dir, "pieces.sqlts"),
      'import {sql} from "@sqlts/core";export function column(flag:boolean){return flag?sql.fragment`peer.email`:sql.fragment`NULL::text`;}export function join(flag:boolean){return flag?sql.fragment`LEFT JOIN reylo_inline_demo.users peer ON peer.id=u.id+1`:sql.empty;}export function changed(flag:boolean){const sideEffect=(flag=false);return column(flag);}',
    );
    const shared =
      "export function joinedShared(enabled:boolean){return sql`SELECT u.id, ${column(enabled)} AS peer_email FROM reylo_inline_demo.users u ${join(enabled)} ORDER BY u.id`;}";
    const safe =
      source.replace(
        'import {sql} from "@sqlts/core";',
        'import {sql} from "@sqlts/core";import {column,join} from "./pieces.sqlts";',
      ) + shared;
    await writeFile(file, safe);
    const p = prepare(safe, file);
    expect(p.queries[0]!.variants).toHaveLength(2);
    expect(p.queries[1]!.variants).toHaveLength(1);
    expect(p.queries[2]!.variants).toHaveLength(2);
    const independent =
      'import {sql} from "@sqlts/core";import {column,join,changed} from "./pieces.sqlts";export const q=(a:boolean,b:boolean)=>sql`SELECT ${column(a)} FROM reylo_inline_demo.users u ${join(b)}`;';
    expect(prepare(independent, file).queries[0]!.variants).toHaveLength(4);
    expect(
      prepare(independent.replace("column(a)", "changed(a)").replace("join(b)", "join(a)"), file)
        .queries[0]!.variants,
    ).toHaveLength(4);
    const mutation =
      'import {sql} from "@sqlts/core";export function q(flag:boolean){const mutate=()=>{flag=!flag;};return sql`SELECT id FROM users ${sql.where(flag&&sql`id>0`,flag&&sql`id<10`)}`;}';
    expect(prepare(mutation, file).queries[0]!.variants).toHaveLength(4);
    const mutable =
      'import {sql} from "@sqlts/core";let flag=true;export const q=()=>sql`SELECT id FROM users ${sql.where(flag&&sql`id>0`,flag&&sql`id<10`)}`;';
    expect(prepare(mutable, file).queries[0]!.variants).toHaveLength(4);
    await writeFile(
      resolve(dir, "caller.ts"),
      'import {joined,joinedShared,complementary} from "./queries.sqlts";import type {PostgresClient} from "reylo";export async function typed(db:PostgresClient,flag:boolean){const rows=await joined(flag).run(db);const nullable:string|null|undefined=rows[0]?.peer_email;const definite:string|undefined=(await complementary(flag).run(db))[0]?.email;return {nullable,definite};}',
    );
    await writeFile(
      resolve(dir, "tsconfig.json"),
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
    const run = async (args: string[]) => {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, out + err).toBe(0);
      return out;
    };
    await run([
      Bun.which("node")!,
      "--env-file=.env",
      "node_modules/typescript/bin/tsc",
      "--runExternalCode",
      "-p",
      resolve(dir, "tsconfig.json"),
    ]);
    const runner = resolve(dir, "run.ts");
    await writeFile(
      runner,
      'import {joined,joinedShared,complementary} from "./queries.sqlts";import {Pool} from "pg";import {deepEqual,ok} from "node:assert/strict";const db=new Pool({connectionString:process.env.DATABASE_URL});try{for(const flag of [true,false]){for(const q of [joined(flag),joinedShared(flag),complementary(flag)]){const c=q.compile();const rows=await q.run(db);deepEqual(rows,(await db.query(c.text,c.values)).rows);}ok((await complementary(flag).run(db)).every(r=>r.email!==null));}console.log("verified");}finally{await db.end();}',
    );
    for (const args of [
      [
        Bun.which("node")!,
        "--env-file=.env",
        "--import",
        "@sqlts/core/register",
        runner,
      ],
      [process.execPath, "--preload", "@sqlts/core/register", runner],
    ])
      expect(await run(args)).toContain("verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

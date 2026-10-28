import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-mutations-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const queries = `import {sql} from '@sqlts/core';
export function insert(id:number,name:string){return sql\`INSERT INTO reylo_inline_demo.users(id,org_id,name,email) VALUES(\${id},987654,\${name},NULL) RETURNING id,name,email\`;}
export function update(id:number,name:string,email=false){return sql\`UPDATE reylo_inline_demo.users SET name=\${name} \${email ? sql\`,email=NULL\` : sql.empty} WHERE id=\${id} AND org_id=987654 RETURNING id,name,email\`;}
export function upsert(id:number,name:string){return sql\`INSERT INTO reylo_inline_demo.users(id,org_id,name) VALUES(\${id},987654,\${name}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name WHERE reylo_inline_demo.users.org_id=987654 RETURNING id,name\`;}
export function bulk(ids:number[],names:string[]){return sql\`INSERT INTO reylo_inline_demo.users(id,org_id,name) SELECT id,987654,name FROM unnest(\${ids}::int[],\${names}::text[]) AS input(id,name) RETURNING id,name\`;}
export function remove(id:number){return sql\`DELETE FROM reylo_inline_demo.users WHERE id=\${id} AND org_id=987654 RETURNING id\`;}
export function silent(id:number){return sql\`DELETE FROM reylo_inline_demo.users WHERE id=\${id} AND org_id=987654\`;}
export function writable(id:number){return sql\`WITH inserted AS (INSERT INTO reylo_inline_demo.users(id,org_id,name) VALUES(\${id},987654,'CTE') RETURNING id,name) SELECT id,name FROM inserted\`;}
`;
await writeFile(resolve(dir, "queries.sqlts"), queries);
await writeFile(
  resolve(dir, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: "preserve",
      moduleResolution: "bundler",
      target: "esnext",
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["node"],
    },
    contentMappers: [{ package: "@sqlts/core", extensions: [".sqlts"] }],
    include: ["*.ts", "*.sqlts"],
  }),
);
async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, a, b] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, output: a + b };
}
const check = () =>
  run([
    Bun.which("node")!,
    "--env-file=.env",
    "node_modules/typescript/bin/tsc",
    "--runExternalCode",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);
test("mutation inputs and RETURNING types are inferred; bad columns and values fail", async () => {
  await writeFile(
    resolve(dir, "types.ts"),
    `import {insert,bulk,silent} from './queries.sqlts';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
export type NoReturning=Assert<Equal<Awaited<ReturnType<ReturnType<typeof silent>['run']>>,never[]>>;
type Row=Awaited<ReturnType<ReturnType<typeof insert>['run']>>[number];
export const consume=(r:Row):{id:number;name:string;email:string|null}=>r;
// @ts-expect-error wrong insert value
insert(1,42);
// @ts-expect-error wrong bulk array
bulk(['oops'],['Name']);
// @ts-expect-error nonexistent RETURNING column
export const bad=(r:Row)=>r.nonexistent;
`,
  );
  let r = await check();
  expect(r.code, r.output).toBe(0);
  await writeFile(
    resolve(dir, "queries.sqlts"),
    queries.replace("RETURNING id,name,email", "RETURNING id2,name,email"),
  );
  r = await check();
  expect(r.code).not.toBe(0);
  expect(r.output).toContain("id2");
  await writeFile(resolve(dir, "queries.sqlts"), queries);
}, 15_000);
test("mutations execute and roll back through the supplied transaction client on Node/Bun", async () => {
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import {Pool} from 'pg';import {deepEqual,equal} from 'node:assert/strict';import * as q from './queries.sqlts';
const pool=new Pool({connectionString:process.env.DATABASE_URL});const db=await pool.connect();
try { await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(987654)');
// Existing rows are never overwritten; all writes roll back, including failures.
const id=1900000001;equal((await db.query('SELECT id FROM reylo_inline_demo.users WHERE id BETWEEN $1 AND $2',[id,id+4])).rowCount,0);
deepEqual(await q.insert(id,"x' OR TRUE; --").run(db),[{id,name:"x' OR TRUE; --",email:null}]);
await db.query('SAVEPOINT duplicate_test');
try {await q.insert(id,'Duplicate').run(db);throw new Error('Expected unique violation');}catch(error){equal((error as {code?:string}).code,'23505');}finally{await db.query('ROLLBACK TO SAVEPOINT duplicate_test');}
deepEqual(await q.update(id,'Updated',true).run(db),[{id,name:'Updated',email:null}]);
deepEqual(await q.update(id,'Again',false).run(db),[{id,name:'Again',email:null}]);
deepEqual(await q.upsert(id,'Conflict').run(db),[{id,name:'Conflict'}]);
deepEqual(await q.upsert(id+1,'New').run(db),[{id:id+1,name:'New'}]);
deepEqual(await q.bulk([id+2,id+3],['A','B']).run(db),[{id:id+2,name:'A'},{id:id+3,name:'B'}]);
deepEqual(await q.bulk([],[]).run(db),[]);
deepEqual(await q.writable(id+4).run(db),[{id:id+4,name:'CTE'}]);
deepEqual(await q.remove(id).run(db),[{id}]);deepEqual(await q.remove(id).run(db),[]);
deepEqual(await q.silent(id+1).run(db),[]);
console.log('mutation transactions verified');
}finally{await db.query('ROLLBACK');db.release();await pool.end();}`,
  );
  for (const args of [
    [Bun.which("node")!, "--env-file=.env", "--import", "@sqlts/core/register", runner],
    [process.execPath, "--preload", "@sqlts/core/register", runner],
  ]) {
    const r = await run(args);
    expect(r.code, r.output).toBe(0);
  }
}, 20_000);

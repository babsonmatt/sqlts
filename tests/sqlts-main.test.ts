import { afterAll, beforeAll, expect, test } from "bun:test";
import { Pool } from "pg";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const name = `sqlts_main_${crypto.randomUUID().replaceAll("-", "")}`;
const url = new URL(process.env.DATABASE_URL!);
url.pathname = "/" + name;
let created = false;
let dir = "";
beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${name}`);
  created = true;
  const db = new Pool({ connectionString: url.href });
  try {
    await db.query(
      `CREATE TABLE users(id int CONSTRAINT users_pk PRIMARY KEY, email text NOT NULL CONSTRAINT users_email_key UNIQUE, amount int NOT NULL);
    INSERT INTO users VALUES (1,'a',10),(2,'b',20);
    CREATE VIEW user_view AS SELECT id,email FROM users;
    CREATE FUNCTION boom() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'custom failure' USING ERRCODE='Z123', CONSTRAINT='chosen_at_runtime'; END $$;`.replace(
        "'Z123'",
        "'Z1234'",
      ),
    );
  } finally {
    await db.end();
  }
  await mkdir("work", { recursive: true });
  dir = await mkdtemp(resolve("work/sqlts-main-"));
  await writeFile(
    resolve(dir, "queries.sqlts"),
    `import {sql} from 'reylo-sqlts-experiment';
export function insert(id:number,email:string){return sql\`INSERT INTO users(id,email,amount) VALUES(\${id},\${email},1) RETURNING id\`;}
export function conditional(id:number,email:string,detail:boolean){return sql\`INSERT INTO users(id,email,amount) VALUES(\${id},\${email},1) RETURNING id\${detail?sql\`,email\`:sql.empty}\`;}
export function wrapped(id:number,email:string,detail:boolean){return conditional(id,email,detail);}
export function custom(){return sql\`SELECT boom() AS value\`;}
export function byId(id:number){return sql\`WITH selected AS (SELECT id,email FROM users) SELECT * FROM selected WHERE id=\${id}\`;}
export function view(id:number){return sql\`SELECT * FROM user_view WHERE id=\${id}\`;}
export function window(){return sql\`SELECT sum(amount) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total FROM users ORDER BY id\`;}
export function excluding(){return sql\`SELECT sum(amount) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING EXCLUDE CURRENT ROW) AS total FROM users\`;}
export function projection(){return sql\`SELECT length(t) AS n FROM (SELECT NULL::int AS length) t\`;}
`,
  );
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
      contentMappers: [{ package: "reylo-sqlts-experiment", extensions: [".sqlts"] }],
      include: ["types.ts", "*.sqlts"],
    }),
  );
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
});
async function run(args: string[]) {
  const p = Bun.spawn(args, {
    env: { ...process.env, DATABASE_URL: url.href },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, output: out + err };
}
test("pinned main infers constraint names, CTE/view cardinality, windows and extension values", async () => {
  await writeFile(
    resolve(dir, "types.ts"),
    `import * as q from './queries.sqlts';import type {PostgresClient} from 'reylo';
export async function types(db:PostgresClient){
 const one:{id:number;email:string}|null=await q.byId(1).execute(db);
 const view:{id:number;email:string}|null=await q.view(1).execute(db);
 const totals:{total:bigint}[]=await q.window().run(db);
 const excluded:{total:bigint|null}[]=await q.excluding().run(db);
 const projected:{n:number|null}[]=await q.projection().run(db);
 const result=await q.insert(3,'a').try(db);
 if(result.error?.code==='23505'){
const constraint:'users_pk'|'users_email_key'|undefined=result.error.constraint;
const table:'users'|undefined=result.error.table;
const condition:'unique_violation'=result.error.condition;
// @ts-expect-error unrelated constraint cannot be named by this statement
const wrong:'other_table_key'=result.error.constraint;
 }
 const detailed=await q.wrapped(3,'a',true).try(db);
 if(detailed.value){const email:string=detailed.value[0]!.email;}
 if(detailed.error?.code==='23505'){const constraint:'users_pk'|'users_email_key'|undefined=detailed.error.constraint;}
 const custom=await q.custom().try(db);if(custom.error){const code:string=custom.error.code;const name:string|undefined=custom.error.constraint;
 // @ts-expect-error a user function can raise arbitrary codes and names
 const literal:'users_email_key'=custom.error.constraint;}
 return {one,view,totals,excluded,projected};
}`,
  );
  const r = await run([
    "node",
    "node_modules/typescript/bin/tsc",
    "--runExternalCode",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);
  expect(r.code, r.output).toBe(0);
}, 30000);
test("main runtime decodes values, reports constraint names and custom SQLSTATEs on Node/Bun", async () => {
  const extensionDb = new Pool({ connectionString: url.href });
  try {
    await extensionDb.query("CREATE EXTENSION vector; CREATE EXTENSION hstore");
  } finally {
    await extensionDb.end();
  }
  await writeFile(
    resolve(dir, "values.sqlts"),
    `import {sql} from 'reylo-sqlts-experiment';
export function values(v:number[],h:Record<string,string|null>){return sql\`SELECT \${v}::vector AS embedding,\${h}::hstore AS attrs,interval '1 day 02:03:04' AS duration\`;}
`,
  );
  await writeFile(
    resolve(dir, "types.ts"),
    `import {values} from './values.sqlts';import type {PostgresClient} from 'reylo';
export async function check(db:PostgresClient){const row:{embedding:number[]|null;attrs:Record<string,string|null>|null;duration:string}=await values([1],{a:null}).one(db);
// @ts-expect-error vectors take numeric arrays
values(['wrong'],{});return row;}`,
  );
  const checked = await run([
    "node",
    "node_modules/typescript/bin/tsc",
    "--runExternalCode",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);
  expect(checked.code, checked.output).toBe(0);
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import * as q from './queries.sqlts';import {values} from './values.sqlts';import {Pool} from 'pg';import postgres from 'postgres';import {deepEqual,equal,ok} from 'node:assert/strict';
const db=new Pool({connectionString:process.env.DATABASE_URL});try{
 equal(q.byId(1).cardinality,'maybeOne');deepEqual(await q.byId(1).execute(db),{id:1,email:'a'});equal(await q.view(-1).execute(db),null);
 deepEqual(await q.window().run(db),[{total:10n},{total:30n}]);
 deepEqual(await values([1,2.5],{hello:'world',empty:null}).one(db),{embedding:[1,2.5],attrs:{hello:'world',empty:null},duration:'P1DT2H3M4S'});
 deepEqual(await q.projection().run(db),[{n:null}]);
 const duplicate=await q.insert(3,'a').try(db);equal(duplicate.error.constraint,'users_email_key');equal(duplicate.error.code,'23505');equal(duplicate.error.table,'users');ok(duplicate.error instanceof Error);
 const custom=await q.custom().try(db);equal(custom.error.code,'Z1234');equal(custom.error.condition,undefined);equal(custom.error.constraint,'chosen_at_runtime');
 if(globalThis.Bun){const {SQL}=await import('bun');const native=new SQL(process.env.DATABASE_URL);try{equal((await q.insert(3,'a').try(native)).error.constraint,'users_email_key');equal((await q.custom().try(native)).error.code,'Z1234');}finally{await native.close();}}
 const sql=postgres(process.env.DATABASE_URL,{max:1});try{const conn=await sql.reserve();try{
await q.byId(1).run(conn);await q.byId(2).run(conn);
const prepared=await conn.unsafe('SELECT count(*)::int AS n FROM pg_prepared_statements WHERE statement=$1',[q.byId(1).compile().text]);equal(prepared[0].n,1);
equal((await q.insert(3,'a').try(conn)).error.constraint,'users_email_key');
 }finally{conn.release();}}finally{await sql.end();}
 console.log('main runtime passed');
}finally{await db.end();}`,
  );
  for (const cmd of [
    ["node", "--import", "reylo-sqlts-experiment/register", runner],
    [process.execPath, "--preload", "reylo-sqlts-experiment/register", runner],
  ]) {
    const r = await run(cmd);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("main runtime passed");
  }
}, 30000);

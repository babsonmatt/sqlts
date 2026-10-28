import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("work", { recursive: true });
const dir = await mkdtemp(resolve("work/sqlts-parity-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const queries = `import {sql} from '@sqlts/core';
export function computed(){return sql\`SELECT name,upper(email) AS upper_email,coalesce(email,'') AS display_email,email IS NOT NULL AS has_email FROM reylo_inline_demo.users ORDER BY id\`;}
export function nested(){return sql\`SELECT u.id,jsonb_build_object('name',u.name,'email',u.email) AS profile,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name)), '[]') FROM reylo_inline_demo.users p WHERE p.org_id=u.org_id) AS peers FROM reylo_inline_demo.users u ORDER BY u.id\`;}
export function aggregate(){return sql\`SELECT count(*) AS total,sum(id) AS sum_id FROM reylo_inline_demo.users\`;}
export function grouped(){return sql\`SELECT org_id,sum(id) AS total,array_agg(id) AS ids FROM reylo_inline_demo.users GROUP BY org_id\`;}
export function mapping(){return sql\`SELECT 1::bigint AS big,12.50::numeric AS decimal,'2026-01-01'::date AS day,ARRAY[1,2] AS ids\`;}
export function user(id:number){return sql\`SELECT id,name FROM reylo_inline_demo.users WHERE id=\${id}\`;}
export function json(value:{x:number}){return sql\`SELECT \${value}::jsonb('{"type":"object","properties":{"x":{"type":"integer"}},"required":["x"],"additionalProperties":false}') AS payload\`;}
export function jsonPair(a:{x:number},b:{x:number}){return sql\`SELECT \${a}::jsonb('{"type":"object","properties":{"x":{"type":"integer"}},"required":["x"]}') AS a,\${b}::jsonb('{"type":"object","properties":{"x":{"type":"integer"}},"required":["x"]}') AS b\`;}
export function divide(n:number){return sql\`SELECT 10/\${n}::int AS value\`;}
export function explain(id:number){return sql\`EXPLAIN SELECT id FROM reylo_inline_demo.users WHERE id=\${id}\`;}
export function silent(){return sql\`DELETE FROM reylo_inline_demo.users WHERE false\`;}
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
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, output: out + err };
}
test("inference, optional execution cardinality and PostgreSQL error codes reach callers", async () => {
  await writeFile(
    resolve(dir, "types.ts"),
    `import * as q from './queries.sqlts';
import type {PostgresClient} from 'reylo';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Row<F extends (...args:never[])=>{run:(db:PostgresClient)=>Promise<unknown[]>}>=Awaited<ReturnType<ReturnType<F>['run']>>[number];
export type Computed=Assert<Equal<Row<typeof q.computed>,{name:string;upper_email:string|null;display_email:string;has_email:boolean}>>;
export type Nested=Assert<Equal<Row<typeof q.nested>,{id:number;profile:{name:string;email:string|null};peers:{id:number;name:string}[]}>>;
export type Aggregate=Assert<Equal<Row<typeof q.aggregate>,{total:bigint;sum_id:bigint|null}>>;
export type Grouped=Assert<Equal<Row<typeof q.grouped>,{org_id:number;total:bigint;ids:number[]}>>;
export type Mapping=Assert<Equal<Row<typeof q.mapping>,{big:bigint;decimal:string;day:string;ids:number[]}>>;
export async function caller(db:PostgresClient){
 const person:{id:number;name:string}|null=await q.user(1).execute(db);
 const aggregate:{total:bigint;sum_id:bigint|null}=await q.aggregate().execute(db);
 const all:{org_id:number;total:bigint;ids:number[]}[]=await q.grouped().execute(db);
 const noRows:void=await q.silent().execute(db);
 const metadata=await q.user(1).runWithMetadata(db);
 const countedRows:{id:number;name:string}[]=metadata.rows;
 const affected:number|null=metadata.affectedRows;
 const command:string|null=metadata.command;
 const emptyRows:never[]=(await q.silent().runWithMetadata(db)).rows;
 // @ts-expect-error metadata does not erase the inferred result shape
 const wrongCountedRows:{missing:string}[]=metadata.rows;
 // @ts-expect-error unknown client metadata must not be treated as a guaranteed number
 const guaranteedCount:number=metadata.affectedRows;
 const one:{id:number;name:string}=await q.user(1).one(db);
 const old:{id:number;name:string}[]=await q.user(1).run(db);
 const result=await q.divide(0).try(db);
 if(result.error?.condition==='division_by_zero'){const code:'22012'=result.error.code;console.log(code);}
 // @ts-expect-error array API remains an array
 const bad:{id:number;name:string}=await q.user(1).run(db);
 // @ts-expect-error nonexistent PostgreSQL error condition
 if(result.error?.condition==='made_up_error'){}
 // @ts-expect-error schema-annotated input is still checked
 q.json({x:'wrong'});
 return {person,aggregate,all,noRows,one,old,bad};
}`,
  );
  const r = await run([
    "node",
    "--env-file=.env",
    "node_modules/typescript/bin/tsc",
    "--runExternalCode",
    "--pretty",
    "false",
    "-p",
    resolve(dir, "tsconfig.json"),
  ]);
  expect(r.code, r.output).toBe(0);
}, 20_000);
test("compiled JSON syntax, schemas, cardinality, errors and tracing work on Node and Bun", async () => {
  const runner = resolve(dir, "run.ts");
  await writeFile(
    runner,
    `import * as q from './queries.sqlts';
import {Pool} from 'pg';import {deepEqual,equal,ok,rejects,throws} from 'node:assert/strict';
import {subscribeQueries,CardinalityError} from '../../src/runtime.ts';
import {enableQueryTracing} from '../../src/tracing.ts';
import {channel} from 'node:diagnostics_channel';
const db=new Pool({connectionString:process.env.DATABASE_URL});
try{
 const query=q.json({x:3});ok(!query.compile().text.includes('properties'));deepEqual(query.compile().values,[{x:3}]);
 deepEqual(await query.run(db),[{payload:{x:3}}]);deepEqual(await q.jsonPair({x:1},{x:2}).run(db),[{a:{x:1},b:{x:2}}]);
 await rejects(()=>q.json({x:1.5}).run(db));await rejects(()=>q.json({x:1.5}).try(db));
 equal(query.inputSchema.type,'object');equal(query.outputSchema.type,'array');
 deepEqual(query['~standard'].jsonSchema.output({target:'draft-2020-12'}),query.outputSchema);
 throws(()=>query['~standard'].jsonSchema.output({target:'draft-07'}),/Unsupported JSON Schema target/);
 query.inputSchema.properties={};ok('p0' in query.inputSchema.properties);
 const first=(await q.computed().run(db))[0];equal(typeof first.display_email,'string');equal(typeof first.has_email,'boolean');
 const nested=(await q.nested().run(db))[0];equal(typeof nested.profile.name,'string');ok(Array.isArray(nested.peers));
 deepEqual(await q.mapping().execute(db),{big:1n,decimal:'12.50',day:'2026-01-01',ids:[1,2]});
 equal(q.user(1).cardinality,'maybeOne');equal(await q.user(-1).execute(db),null);equal(await q.user(-1).maybeOne(db),null);
 await rejects(()=>q.user(-1).one(db),CardinalityError);await rejects(()=>q.computed().maybeOne(db),CardinalityError);
 deepEqual(await q.user(1).with(db)(),await q.user(1).run(db));equal(await q.silent().execute(db),undefined);
 ok((await q.explain(1).run(db)).length>0);
 const errors=await q.divide(0).try(db);equal(errors.error.code,'22012');equal(errors.error.condition,'division_by_zero');ok(errors.error.cause);
 deepEqual(await q.divide(2).try(db),{value:[{value:5}]});
 const events=[];const stop=subscribeQueries(e=>events.push(e));const stopBad=subscribeQueries(()=>{throw Error('observer');});
 await q.user(1).run(db);await q.divide(0).try(db);stop();stopBad();
 deepEqual(events.map(e=>e.phase),['start','end','start','error']);equal(events[0].id,events[1].id);ok(events[1].durationMs>=0);ok(!('params' in events[0]));
 await q.user(1).run(db);equal(events.length,4);
 const traced=[];const dc=channel('sqlts:query');const listener=e=>traced.push(e);dc.subscribe(listener);const disable=enableQueryTracing();
 await q.user(1).run(db);disable();dc.unsubscribe(listener);deepEqual(traced.map(e=>e.phase),['start','end']);
 if(globalThis.Bun){
  const {SQL}=await import('bun');const native=new SQL(process.env.DATABASE_URL);
  try{const result=await q.divide(0).try(native);equal(result.error?.code,'22012');equal(result.error?.condition,'division_by_zero');}
  finally{await native.close();}
 }
 console.log('parity runtime passed');
}finally{await db.end();}
`,
  );
  for (const command of [
    ["node", "--env-file=.env", "--import", "@sqlts/core/register", runner],
    [process.execPath, "--preload", "@sqlts/core/register", runner],
  ]) {
    const r = await run(command);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain("parity runtime passed");
  }
}, 25_000);

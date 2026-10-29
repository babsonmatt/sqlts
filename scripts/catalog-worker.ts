import { existsSync, readFileSync } from "node:fs";
import postgres from "postgres";
import type { Catalog, Relation, SqlFunction, SqlType } from "../src/catalog.ts";

// Runs on Node or Bun. The launcher loads .env and .env.local; .reylo.yaml's direct_url wins.
let url = process.env.DATABASE_URL;
for (const file of [".reylo.yaml", ".reylo.yml"]) {
  if (!existsSync(file)) continue;
  const line = /^direct_url:[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(readFileSync(file, "utf8"))?.[1];
  const written = line?.replace(/^(["'])(.*)\1$/, "$2");
  if (written)
    url = written.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      const value = process.env[key];
      if (value === undefined) throw new Error("Missing database configuration variable");
      return value;
    });
  break;
}
if (!url || !/^postgres(?:ql)?:/.test(url))
  throw new Error("A PostgreSQL development database is required");
// Notices would otherwise go to stdout, which carries the catalog.
const db = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
const query = async <T>(text: string) => [...(await db.unsafe(text))] as T[];
try {
  // Read catalog metadata only: no user query or application code is executed.
  const rows = await query<{
    schema: string;
    table: string;
    visible: boolean;
    column: string | null;
    type: string | null;
    nullable: boolean;
  }>(`
    SELECT n.nspname AS schema, c.relname AS table,
      pg_catalog.pg_table_is_visible(c.oid) AS visible,
      a.attname AS column, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
      NOT a.attnotnull AS nullable
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      AND (pg_catalog.has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE'))
    ORDER BY n.nspname, c.relname, a.attnum
    LIMIT 50001
  `);
  if (rows.length > 50000) throw new Error("Completion catalog exceeds 50000 columns");
  const relations = new Map<string, Relation>();
  for (const row of rows) {
    const key = JSON.stringify([row.schema, row.table]);
    if (!relations.has(key))
      relations.set(key, {
        schema: row.schema,
        name: row.table,
        visible: row.visible,
        columns: [],
      });
    if (row.column)
      relations
        .get(key)!
        .columns.push({ name: row.column, type: row.type!, nullable: row.nullable });
  }
  const keywords = await query<{ word: string }>(`SELECT word FROM pg_catalog.pg_get_keywords()`);
  const functions = await query<SqlFunction>(`
    SELECT n.nspname AS schema, p.proname AS name,
      pg_catalog.pg_function_is_visible(p.oid) AS visible,
      pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
      ARRAY(SELECT pg_catalog.format_type(t, NULL) FROM unnest(p.proargtypes::oid[]) t) AS "inputTypes",
      pg_catalog.pg_get_function_result(p.oid) AS result,
      p.pronargdefaults AS defaults,
      CASE WHEN p.provariadic <> 0 THEN pg_catalog.format_type(p.provariadic, NULL) END AS variadic,
      p.proretset AS "setReturning",
      CASE WHEN rt.typrelid <> 0 THEN
        COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a.attname,
          'type', pg_catalog.format_type(a.atttypid, a.atttypmod), 'nullable', NULL) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a WHERE a.attrelid = rt.typrelid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb)
      ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('name', p.proargnames[i],
          'type', pg_catalog.format_type(p.proallargtypes[i], NULL), 'nullable', NULL) ORDER BY i)
          FROM generate_subscripts(p.proallargtypes, 1) i
          WHERE p.proargmodes[i] IN ('o', 'b', 't') AND p.proargnames[i] <> ''), '[]'::jsonb)
      END AS columns
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type rt ON rt.oid = p.prorettype
    WHERE p.prokind IN ('f', 'a', 'w')
      AND n.nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
    ORDER BY n.nspname, p.proname, p.oid LIMIT 10001
  `);
  if (functions.length > 10000) throw new Error("Completion catalog exceeds 10000 functions");
  const types = await query<SqlType>(`
    SELECT pg_catalog.format_type(t.oid,NULL) AS name,
      CASE WHEN t.typelem <> 0 THEN pg_catalog.format_type(t.typelem,NULL) END AS element,
      CASE WHEN r.rngsubtype IS NOT NULL THEN pg_catalog.format_type(r.rngsubtype,NULL) END AS "rangeSubtype",
      CASE WHEN m.rngtypid IS NOT NULL THEN pg_catalog.format_type(m.rngtypid,NULL) END AS "multirangeRange",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'nullable',NULL) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped), '[]'::jsonb) AS columns
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_range r ON r.rngtypid=t.oid
    LEFT JOIN pg_catalog.pg_range m ON m.rngmultitypid=t.oid
    WHERE pg_catalog.has_schema_privilege(n.oid,'USAGE') ORDER BY t.oid LIMIT 10001
  `);
  if (types.length > 10000) throw new Error("Completion catalog exceeds 10000 types");
  const catalog: Catalog = {
    types,
    functions,
    relations: [...relations.values()],
    schemas: [...new Set([...rows.map((r) => r.schema), ...functions.map((f) => f.schema)])],
    keywords: keywords.map((k) => k.word),
  };
  process.stdout.write(JSON.stringify(catalog));
} finally {
  await db.end();
}

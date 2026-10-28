import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Pool } from "pg";
import {
  bindings,
  raw,
  shape,
  tableName,
  type Compiled,
  type Kind,
  type Options,
  type Row,
} from "./shared.ts";
export interface Built {
  compile(): Compiled;
  run(): Promise<Row[]>;
}
export interface Provider {
  build(options: Options): Built;
  prebuild?(options: Options): Built;
}
export async function provider(
  kind: Kind,
  pool: Pool,
  directory: string,
  schema: string,
): Promise<Provider> {
  const table = tableName(schema);
  if (kind === "pg")
    return {
      build(o) {
        const compiled = raw(table, o);
        return {
          compile: () => compiled,
          run: async () => (await pool.query<Row>(compiled.text, compiled.values)).rows,
        };
      },
    };
  if (kind === "drizzle") {
    const [{ drizzle }, { pgSchema, integer, text }, { and, eq, ilike, isNotNull, asc }] =
      await Promise.all([
        import("drizzle-orm/node-postgres"),
        import("drizzle-orm/pg-core"),
        import("drizzle-orm"),
      ]);
    const users = pgSchema(schema).table("users", {
      id: integer("id").primaryKey(),
      org: integer("org_id").notNull(),
      name: text("name").notNull(),
      email: text("email"),
    });
    const db = drizzle(pool);
    const build = (o: Options, precompile = false): Built => {
      const q = db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.org, o.org),
            o.search ? ilike(users.name, o.search) : undefined,
            o.email ? isNotNull(users.email) : undefined,
          ),
        )
        .orderBy(asc(users.id))
        .limit(o.limit);
      // Empty name compiles once on the client without named server-side reuse.
      // A normal q.execute() calls _prepare() again on every execution.
      const prepared = precompile ? q.prepare("") : undefined;
      return {
        compile() {
          const c = q.toSQL();
          return { text: c.sql, values: c.params };
        },
        run: () => (prepared ? prepared.execute() : q.execute()),
      };
    };
    return { build: (o) => build(o), prebuild: (o) => build(o, true) };
  }
  if (kind === "inline") {
    const module = (await import(pathToFileURL(resolve(directory, "queries.sqlts")).href)) as {
      search(
        org: number,
        search: string | undefined,
        email: boolean,
        limit: number,
      ): { compile(): Compiled; run(pool: Pool): Promise<Row[]> };
    };
    return {
      build(o) {
        const q = module.search(o.org, o.search, o.email, o.limit);
        return { compile: () => q.compile(), run: () => q.run(pool) };
      },
    };
  }
  const queries: { run(pool: Pool, params: Record<string, unknown>): Promise<Row[]> }[] = [];
  const texts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const module = (await import(pathToFileURL(resolve(directory, `query-${i}.sql`)).href)) as {
      default: { run(pool: Pool, params: Record<string, unknown>): Promise<Row[]> };
    };
    queries.push(module.default);
    texts.push(
      raw(table, { org: 10, search: i & 2 ? "User %" : undefined, email: !!(i & 1), limit: 20 })
        .text,
    );
  }
  return {
    build(o) {
      const index = shape(o),
        values = bindings(o),
        params = Object.fromEntries(values.map((v, i) => [`p${i}`, v]));
      const query = queries[index]!;
      return {
        compile: () => ({ text: texts[index]!, values }),
        run: () => query.run(pool, params),
      };
    },
  };
}

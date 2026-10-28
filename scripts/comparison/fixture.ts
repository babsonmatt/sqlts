import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { raw, tableName } from "./shared.ts";
export async function fixture(directory: string, schema: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "esnext",
        module: "preserve",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        types: ["node"],
      },
      contentMappers: [
        { package: "@sqlts/core", extensions: [".sqlts"] },
        { package: "reylo", extensions: [".sql"] },
      ],
      include: ["*.sqlts", "*.sql"],
    }),
  );
  // Reylo scopes its cache by package.json, not merely by tsconfig.json.
  await writeFile(
    resolve(directory, "package.json"),
    JSON.stringify({ name: "reylo-benchmark-fixture", private: true, type: "module" }),
  );
  const table = tableName(schema);
  await writeFile(
    resolve(directory, "queries.sqlts"),
    'import {sql} from "@sqlts/core";\n' +
      "export function search(org:number, search:string|undefined, email:boolean, limit:number) { return sql`SELECT id, name, email FROM " +
      table +
      " ${sql.where(sql.fragment`org_id = ${org}`, search && sql.fragment`name ILIKE ${search}`, email && sql.fragment`email IS NOT NULL`)} ORDER BY id LIMIT ${limit}`; }\n",
  );
  for (let i = 0; i < 4; i++) {
    const text = raw(table, {
      org: 10,
      search: i & 2 ? "User %" : undefined,
      email: !!(i & 1),
      limit: 20,
    }).text;
    await writeFile(
      resolve(directory, `query-${i}.sql`),
      text.replace(/\$(\d+)/g, (_, n: string) => `:p${Number(n) - 1}`),
    );
  }
}

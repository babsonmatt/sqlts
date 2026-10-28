# Conditional SQL examples

These examples use the `.sqlts` API and the repository's demo schema. Use the target project's actual schema and imports; these are not schema declarations.

## One WHERE, required organization, optional grouped search

```ts
import { sql } from "reylo-sqlts-experiment";

export function findUsers(orgId: number, search?: string, minId?: number, onlyWithEmail = false) {
  return sql`
    SELECT u.id, u.name, u.email
    FROM reylo_inline_demo.users u
    ${sql.where(
      sql`u.org_id = ${orgId}`,
      search && sql.or(sql`u.name ILIKE ${`%${search}%`}`, sql`u.email ILIKE ${`%${search}%`}`),
      minId != null && sql`u.id >= ${minId}`,
      onlyWithEmail && sql`u.email IS NOT NULL`,
    )}
    ORDER BY u.id
  `;
}
```

Nested `sql` tags here are fragments. Any can also be written as `sql.fragment`; both spellings compose identically. The outer `sql` remains the complete typed query.

The search predicate is `(name matches OR email matches)`, ANDed with the organization restriction and other present filters. `minId = 0` remains a bound value. An empty search omits that group. `%` and `_` in search input retain ILIKE wildcard semantics; parameterization prevents SQL injection but does not escape wildcard behavior.

If the request requires a literal substring, escape backslash, percent, and underscore in the bound pattern. With PostgreSQL's default LIKE escape character, use `search.replace(/[\\%_]/g, "\\$&")` inside the `%...%` parameter expression. Keep that expression inside the SQL fragment so the analyzer can see the fragment structure. Test `%`, `_`, and backslash as well as a quote-containing input; escaping patterns is separate from parameterizing SQL.

Import `findUsers` from this `.sqlts` file in a TypeScript caller and use `await findUsers(orgId, search).run(db)`. Let the inferred row type flow into the caller. For this direct-return function, `findUsers(orgId, undefined, undefined, true)` selects the database-inferred non-null email branches. Omitted/false flags and runtime booleans retain the appropriate nullable possibilities. Use inferred caller types; do not add manual row interfaces or overloads.

## Keep an existing literal WHERE

```ts
export function findUsersLiteral(orgId: number, search?: string) {
  return sql`
    SELECT u.id, u.name FROM reylo_inline_demo.users u
    WHERE u.org_id = ${orgId}
    ${
      search
        ? sql.fragment`AND (u.name ILIKE ${`%${search}%`} OR u.email ILIKE ${`%${search}%`})`
        : sql.empty
    }
    ORDER BY u.id
  `;
}
```

Here the literal SQL owns the AND and parentheses. Do not insert a second `sql.where` after that WHERE. Do not replace the fragment with an interpolated string containing SQL.

## Older named API

For an existing generated `.ts` query, retain its imported facade and unique name:

```ts
import { sql } from "../.inline/sql.ts";

export function namedUsers(orgId: number, search?: string) {
  return sql.query("namedUsers")`
    SELECT u.id, u.name FROM reylo_inline_demo.users u
    ${sql.where(sql`u.org_id = ${orgId}`, search && sql`u.name ILIKE ${`%${search}%`}`)}
    ORDER BY u.id
  `;
}
```

That named site must be included in generation before its inferred signature exists. In `.sqlts`, standalone `sql` denotes a complete query, while directly nested `sql` or explicit `sql.fragment` denotes a fragment. Keep the existing API when editing named queries.

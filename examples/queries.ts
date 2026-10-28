import { sql } from "../.inline/sql.ts";

export function searchUsers(
  orgId: number,
  search: string | undefined,
  onlyWithEmail: boolean,
  pageSize = 20,
) {
  return sql.query("searchUsers")`
    SELECT u.id, u.name, u.email
    FROM reylo_inline_demo.users u
    ${sql.where(
      sql`u.org_id = ${orgId}`,
      search
        ? sql.or(sql`u.name ILIKE ${`%${search}%`}`, sql`u.email ILIKE ${`%${search}%`}`)
        : undefined,
      onlyWithEmail ? sql`u.email IS NOT NULL` : undefined,
    )}
    ORDER BY u.id
    LIMIT ${pageSize}::int
  `;
}

export function allUsers(onlyWithEmail: boolean) {
  return sql.query("allUsers")`
    SELECT id, name, email FROM reylo_inline_demo.users
    ${sql.where(onlyWithEmail ? sql`email IS NOT NULL` : undefined)}
    ORDER BY id
  `;
}

export function rankedUsers(orgId: number, minimumId: number | undefined) {
  return sql.query("rankedUsers")`
    WITH selected AS MATERIALIZED (
      SELECT id, name FROM reylo_inline_demo.users
      ${sql.where(sql`org_id = ${orgId}`, minimumId === undefined ? undefined : sql`id >= ${minimumId}`)}
    )
    SELECT id, name, row_number() OVER (ORDER BY id) AS position
    FROM selected ORDER BY id
  `;
}

// The original, fully inline style works too. Here we own the ANDs because the
// base WHERE always exists; sql.where above is easier when every predicate is optional.
export function rawSearchUsers(orgId: number, search: string | undefined, onlyWithEmail: boolean) {
  return sql.query("rawSearchUsers")`
    SELECT u.id, u.name, u.email
    FROM reylo_inline_demo.users u
    WHERE u.org_id = ${orgId}
    ${search ? sql`AND u.name ILIKE ${`%${search}%`}` : sql.empty}
    ${onlyWithEmail ? sql`AND u.email IS NOT NULL` : sql.empty}
    ORDER BY u.id
  `;
}

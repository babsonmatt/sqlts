import { sql } from "./sql.ts";

export function userIds(orgId: number) {
  return sql.auto`
    SELECT u.id FROM reylo_inline_demo.users u WHERE u.org_id = ${orgId}
    ORDER BY u.id
  `;
}

// Same input tuple as userIds, different result columns: types must stay distinct.
export function userNames(orgId: number) {
  return sql.auto`
    SELECT u.name, u.email FROM reylo_inline_demo.users u WHERE u.org_id = ${orgId}
    ORDER BY u.id
  `;
}

export function searchUsers(orgId: number, search?: string) {
  return sql.auto`
    SELECT u.id, u.name FROM reylo_inline_demo.users u
    ${sql.where(sql`u.org_id = ${orgId}`, search ? sql`u.name ILIKE ${`%${search}%`}` : undefined)}
    ORDER BY u.id
  `;
}


export function userIdsNew(orgId: number) {
  return sql.auto`
    SELECT u.id FROM reylo_inline_demo.users u WHERE u.org_id = ${orgId}
    ORDER BY u.id DESC
  `;
}

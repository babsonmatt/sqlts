import { sql } from "../.inline/sql";

export function testing(orgId: number) {
  return sql.query("testing")`
    SELECT u.id, lower(u.name) AS lower_name, length(u.name) AS name_length
    FROM reylo_inline_demo.users u WHERE u.org_id = ${orgId}
    ORDER BY u.id
  `;
}

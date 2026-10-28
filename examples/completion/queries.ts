import { sql } from "../../.inline/sql.ts";

// Editor playground: these functions only construct queries. This file executes none.
// Delete a column suffix after a dot, then Ctrl-Space → arrows → Tab to complete it.
// Hover query() for full SQL; hover a SQL function name for its argument signatures.

// r. offers id and display_name, inferred from the CTE's output list.
export function cteUsers(orgId: number) {
  return sql.query("completionCte")`
    WITH recent AS (
      SELECT id, name AS display_name
      FROM reylo_inline_demo.users WHERE org_id = ${orgId}
    )
    SELECT r.id, r.display_name FROM recent r ORDER BY r.id
  `;
}

// s. exposes the subquery's aliases, not every column from users.
export function derivedUsers(orgId: number) {
  return sql.query("completionDerived")`
    SELECT s.id, s.display_name
    FROM (
      SELECT id, name AS display_name
      FROM reylo_inline_demo.users WHERE org_id = ${orgId}
    ) AS s ORDER BY s.id
  `;
}

// Complete low... / len..., and inspect the cached PostgreSQL overload signatures.
export function functionUsers(orgId: number) {
  return sql.query("completionFunctions")`
    SELECT u.id, lower(u.name) AS lower_name, length(u.name) AS name_length
    FROM reylo_inline_demo.users u WHERE u.org_id = ${orgId}
    ORDER BY u.id
  `;
}

// item. offers key and value from jsonb_each's declared OUT parameters.
export function jsonEntries(orgId: number) {
  return sql.query("completionFunctionRows")`
    SELECT u.id, item.key, item.value
    FROM reylo_inline_demo.users u
    CROSS JOIN LATERAL jsonb_each(jsonb_build_object('name', u.name)) AS item
    WHERE u.org_id = ${orgId} ORDER BY u.id
  `;
}

// SET suggests target columns; RETURNING u. suggests the updated row's columns.
export function renameUser(orgId: number, userId: number, name: string) {
  return sql.query("completionUpdate")`
    UPDATE reylo_inline_demo.users AS u SET name = ${name}
    WHERE u.org_id = ${orgId} AND u.id = ${userId}
    RETURNING u.id, u.name
  `;
}

// Complete INSERT columns and EXCLUDED.na... inside DO UPDATE.
export function upsertUser(orgId: number, userId: number, name: string) {
  return sql.query("completionUpsert")`
    INSERT INTO reylo_inline_demo.users AS u (id, org_id, name)
    VALUES (${userId}, ${orgId}, ${name})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    WHERE u.org_id = EXCLUDED.org_id
    RETURNING u.id, u.name
  `;
}

// DELETE/USING and RETURNING have their own completion scopes too.
export function deleteUser(orgId: number, userId: number) {
  return sql.query("completionDelete")`
    DELETE FROM reylo_inline_demo.users AS u
    WHERE u.org_id = ${orgId} AND u.id = ${userId}
    RETURNING u.id, u.name
  `;
}

// MERGE offers target/source columns only where PostgreSQL permits them.
export function mergeUser(orgId: number, userId: number, name: string) {
  return sql.query("completionMerge")`
    MERGE INTO reylo_inline_demo.users AS u
    USING (SELECT ${orgId}::int AS org_id, ${userId}::int AS id, ${name}::text AS name) AS incoming
    ON u.id = incoming.id AND u.org_id = incoming.org_id
    WHEN MATCHED THEN UPDATE SET name = incoming.name
    WHEN NOT MATCHED THEN INSERT (org_id, id, name)
      VALUES (incoming.org_id, incoming.id, incoming.name)
    RETURNING u.id, u.name
  `;
}

// unnest's anyelement is inferred from the integer[] input; n. offers n.
export function arrayItems(ids: number[]) {
  return sql.query("completionArray")`
    SELECT n.n FROM unnest(${ids}::int[]) AS n
  `;
}

// Anonymous record columns are declared in SQL, and Reylo validates the result.
export function recordFields() {
  return sql.query("completionRecord")`
    SELECT r.id, r.display_name
    FROM jsonb_to_record('{"id": 1, "display_name": "Alice"}'::jsonb)
      AS r(id int, display_name text)
  `;
}

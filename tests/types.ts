// Checked by Bun (and optionally tsgo). Not executed. Every expect-error must correspond to a real diagnostic.
import { sql } from "../.inline/sql.ts";
import { searchUsers, rankedUsers } from "../examples/queries.ts";
type Row = Awaited<ReturnType<ReturnType<typeof searchUsers>["run"]>>[number];
type Ranked = Awaited<ReturnType<ReturnType<typeof rankedUsers>["run"]>>[number];
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type InferredId = Assert<Equal<Row["id"], number>>;
export type InferredName = Assert<Equal<Row["name"], string>>;
export type NullableEmail = Assert<Equal<Row["email"], string | null>>;
export type WindowBigint = Assert<Equal<Ranked["position"], bigint>>;
// @ts-expect-error No such column in inferred output
export type MissingColumn = Row["missing"];

export function contracts() {
  // @ts-expect-error Unknown query ID
  sql.query("missing");
  // @ts-expect-error Database inferred integer, not string
  void sql.query("rankedUsers")`${"wrong"}`;
  // @ts-expect-error Even nested fragment parameters must match inferred integers
  void sql.query("rankedUsers")`${sql.where(sql`id = ${"wrong"}`)}`;
  const invalid = sql.where(sql`org_id = ${10}`, Math.random() ? sql`id = ${"wrong"}` : undefined);
  // @ts-expect-error Optional branches cannot contain invalid parameters
  void sql.query("rankedUsers")`${invalid}`;
  // @ts-expect-error Missing mandatory bindings
  void sql.query("rankedUsers")`SELECT 1`;
  // @ts-expect-error Too many bindings
  void sql.query("rankedUsers")`${1} ${2} ${3}`;
  // @ts-expect-error Clauses accept fragments, not SQL strings
  sql.where("id = 1");
}

import { mergeUser, arrayItems, recordFields } from "../examples/completion/queries.ts";
type MergeRow = Awaited<ReturnType<ReturnType<typeof mergeUser>["run"]>>[number];
type ArrayRow = Awaited<ReturnType<ReturnType<typeof arrayItems>["run"]>>[number];
type RecordRow = Awaited<ReturnType<ReturnType<typeof recordFields>["run"]>>[number];
export type MergeId = Assert<Equal<MergeRow["id"], number>>;
export type ArrayElement = Assert<Equal<ArrayRow["n"], number | null>>;
export type RecordName = Assert<Equal<RecordRow["display_name"], string | null>>;

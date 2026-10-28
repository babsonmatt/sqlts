import { sql } from "./sql.ts";
import { userIds, userNames } from "./queries.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Id = Awaited<ReturnType<ReturnType<typeof userIds>["run"]>>[number];
type Name = Awaited<ReturnType<ReturnType<typeof userNames>["run"]>>[number];
export type IdIsNumber = Assert<Equal<Id["id"], number>>;
export type NameIsString = Assert<Equal<Name["name"], string>>;
export type EmailIsNullable = Assert<Equal<Name["email"], string | null>>;
// @ts-expect-error Different query, same inputs: no id in the names result.
export type WrongResult = Name["id"];
export function incorrectParameter() {
  // @ts-expect-error Database requires integer even though JS value is a string.
  return sql.auto`SELECT id FROM reylo_inline_demo.users WHERE org_id = ${"wrong"}`;
}

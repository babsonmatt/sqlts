import { userIds, userNames, searchUsersShorthand } from "./queries.sqlts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Id = Awaited<ReturnType<ReturnType<typeof userIds>["run"]>>[number];
type Name = Awaited<ReturnType<ReturnType<typeof userNames>["run"]>>[number];
export type IdIsNumber = Assert<Equal<Id["id"], number>>;
export type NameIsString = Assert<Equal<Name["name"], string>>;
export type EmailIsNullable = Assert<Equal<Name["email"], string | null>>;
// @ts-expect-error The names query does not select id.
export type WrongColumn = Name["id"];

type Shorthand = Awaited<ReturnType<ReturnType<typeof searchUsersShorthand>["run"]>>[number];
export type ShorthandResult = Assert<Equal<Shorthand, { id: number; name: string }>>;

import { directory } from "./directory.sqlts";
import { nextPeers } from "./peers.sqlts";
import { spending } from "./spending.sqlts";
import { hierarchy } from "./hierarchy.sqlts";

// These compare inferred types; they do not supply or override result types.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Member = Awaited<ReturnType<ReturnType<typeof directory>["run"]>>[number];
type Peer = Awaited<ReturnType<ReturnType<typeof nextPeers>["run"]>>[number];
type Spender = Awaited<ReturnType<ReturnType<typeof spending>["run"]>>[number];
type Node = Awaited<ReturnType<ReturnType<typeof hierarchy>["run"]>>[number];

export type MemberId = Assert<Equal<Member["id"], number>>;
export type MemberEmail = Assert<Equal<Member["email"], string | null>>;
export type WindowPosition = Assert<Equal<Member["position"], bigint>>;
export type NextId = Assert<Equal<Peer["next_id"], number | null>>;
export type TotalCents = Assert<Equal<Spender["total_cents"], bigint>>;
export type LargestOrder = Assert<Equal<Spender["largest_order_cents"], number | null>>;
export type TreeDepth = Assert<Equal<Node["depth"], number>>;
// Reylo conservatively permits null array elements even though this query appends IDs.
export type TreePath = Assert<Equal<Node["path"], (number | null)[]>>;

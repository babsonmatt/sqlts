/** Bounded proof of a branch condition or scalar binding; source leaves retain lexical identity. */
export type BranchProof =
  | { kind: "expression"; text: string; bindings: Record<string, BranchProof> }
  | { kind: "unknown" }
  | { kind: "source"; start: number; end: number }
  | { kind: "literal"; type: string }
  | { kind: "default"; value: BranchProof; fallback: BranchProof }
  | { kind: "not"; value: BranchProof }
  | { kind: "binary"; op: string; left: BranchProof; right: BranchProof };

export function mapProofSources(
  proof: BranchProof,
  map: (start: number, end: number) => { start: number; end: number } | undefined,
): BranchProof {
  switch (proof.kind) {
    case "expression":
      return {
        ...proof,
        bindings: Object.fromEntries(
          Object.entries(proof.bindings).map(([name, value]) => [
            name,
            mapProofSources(value, map),
          ]),
        ),
      };
    case "source": {
      const range = map(proof.start, proof.end);
      return range ? { kind: "source", ...range } : { kind: "unknown" };
    }
    case "default":
      return {
        ...proof,
        value: mapProofSources(proof.value, map),
        fallback: mapProofSources(proof.fallback, map),
      };
    case "not":
      return { ...proof, value: mapProofSources(proof.value, map) };
    case "binary":
      return {
        ...proof,
        left: mapProofSources(proof.left, map),
        right: mapProofSources(proof.right, map),
      };
    default:
      return proof;
  }
}

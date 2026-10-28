import type { BranchProof } from "./branch-proof.ts";

// Shared by extraction and runtime so the SQL shape has one rendering definition.
export type Part =
  | string
  | { readonly value: unknown; readonly expression?: string; readonly proof?: BranchProof };
export type Parts = readonly Part[];
export type Clause = "where" | "and" | "or";

export function group(kind: Clause, operands: readonly Parts[]): Parts {
  const present = operands.filter((p) => p.some((v) => typeof v !== "string" || v.trim()));
  if (!present.length) return kind === "where" ? [] : [kind === "and" ? "TRUE" : "FALSE"];
  const parts: Part[] = [kind === "where" ? "WHERE " : "("];
  present.forEach((p, i) => {
    if (i) parts.push(kind === "or" ? " OR " : " AND ");
    parts.push("(", ...p, ")");
  });
  if (kind !== "where") parts.push(")");
  return parts;
}

export function render(parts: Parts) {
  const values: unknown[] = [];
  let named = "";
  let text = "";
  const holes: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      named += p;
      text += p;
    } else {
      holes.push(named.length);
      named += `:p${values.length}`;
      values.push(p.value);
      text += `$${values.length}`;
    }
  }
  return { named, text, values, holes };
}

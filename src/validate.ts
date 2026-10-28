import { tokens } from "./adapter/lex.ts";
import { render, type Parts } from "./parts.ts";

export function validatePlaceholders(parts: Parts): void {
  const { named, holes } = render(parts);
  const found = tokens(named)
    .filter((t) => t.kind === "code")
    .flatMap((t) =>
      [...t.text.matchAll(/(?<!:):([A-Za-z_][A-Za-z_0-9]*)|\$[0-9]+/g)].map((m) => ({
        start: t.start + m.index,
        name: m[1],
      })),
    );
  if (
    found.length !== holes.length ||
    found.some((p, i) => p.start !== holes[i] || p.name !== `p${i}`)
  )
    throw new Error(
      "Interpolations must be SQL values outside quotes/comments; authored placeholders are unsupported",
    );
}

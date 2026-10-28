import { extract } from "../src/extract.ts";
import { render } from "../src/parts.ts";
const file = process.argv[2] ?? "examples/queries.ts";
const filter = process.argv[3];
const queries = extract(await Bun.file(file).text(), file);
const found = queries.filter((q) => !filter || q.id === filter);
if (!found.length) throw new Error("No matching inline query");
for (const q of found) {
  console.log(`\n${q.id}: ${q.alternatives.length} possible source paths (values not evaluated)`);
  for (const [i, v] of q.alternatives.entries()) {
    console.log(`\nAlternative ${i + 1}: ${v.conditions.join("; ") || "unconditional"}`);
    console.log(render(v.parts).text.trim());
    v.parts
      .flatMap((p) => (typeof p === "string" ? [] : [p.expression]))
      .forEach((e, j) => console.log(`$${j + 1} ← ${e}`));
  }
}

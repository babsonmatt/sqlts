import { PreviewService, position } from "../src/preview.ts";
const file = "examples/queries.ts";
const source = await Bun.file(file).text();
const at = position(source, source.indexOf('sql.query("searchUsers")') + 4);
const samples: number[] = [];
for (let i = 0; i < 20; i++) {
  const service = new PreviewService();
  service.documents.set(file, source);
  const start = performance.now();
  service.hover(file, at);
  samples.push(performance.now() - start);
}
const service = new PreviewService();
service.documents.set(file, source);
service.hover(file, at);
const start = performance.now();
for (let i = 0; i < 1000; i++) service.hover(file, at);
samples.sort((a, b) => a - b);
console.log({
  coldPreviewMedianMs: +samples[10]!.toFixed(3),
  cachedHoverMeanMs: +((performance.now() - start) / 1000).toFixed(3),
  parsesFor1001Hovers: service.parses,
  databaseConnections: 0,
});

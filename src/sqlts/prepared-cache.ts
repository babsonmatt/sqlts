import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepare } from "./transform.ts";
import { sourceFingerprint } from "./shared-fragments.ts";

type Prepared = ReturnType<typeof prepare>;
const entries = new Map<
  string,
  { source: string; prepared: Prepared; size: number; weight: number }
>();
const stats = { hits: 0, misses: 0, evictions: 0 };
const maxEntries = 128,
  maxCharacters = 2_000_000,
  maxEstimatedBytes = 16_000_000;
let characters = 0,
  estimatedBytes = 0;
export const preparationStats = () => ({
  ...stats,
  entries: entries.size,
  characters,
  estimatedBytes,
});
export function clearPreparationCache() {
  entries.clear();
  characters = estimatedBytes = 0;
  stats.hits = stats.misses = stats.evictions = 0;
}
/** Cache only AST/fragment expansion. SQL analysis and schema validation still run
 * on every analyze call. Saved dependency contents are checked before every hit. */
export function prepareCached(source: string, file: string): Prepared {
  file = resolve(file);
  const entry = entries.get(file);
  if (entry?.source === source) {
    let fresh = true;
    for (const [dependency, fingerprint] of Object.entries(entry.prepared.fingerprints ?? {})) {
      try {
        if (sourceFingerprint(readFileSync(dependency, "utf8")) !== fingerprint) fresh = false;
      } catch {
        fresh = false;
      }
      if (!fresh) break;
    }
    if (fresh) {
      stats.hits++;
      entries.delete(file);
      entries.set(file, entry);
      return entry.prepared;
    }
  }
  stats.misses++;
  let size = source.length;
  const prepared = prepare(source, file, false, {
    readSource(path) {
      const text = readFileSync(path, "utf8");
      size += text.length;
      return text;
    },
  });
  // A small source can expand into many large SQL/source-map variants. Include
  // that retained work in eviction weight; this is an estimate, not a JS heap cap.
  let weight = size * 8;
  for (const query of prepared.queries) {
    weight += query.sourceMaps.reduce((n, map) => n + map.length * 8, 0);
    for (const parts of query.variants)
      for (const part of parts)
        weight += typeof part === "string" ? part.length * 2 : JSON.stringify(part).length * 2;
    for (const alternative of query.alternatives)
      weight += JSON.stringify(alternative.guards ?? []).length * 2;
  }
  if (entry) {
    characters -= entry.size;
    estimatedBytes -= entry.weight;
    entries.delete(file);
  }
  if (size <= maxCharacters && weight <= maxEstimatedBytes) {
    while (
      entries.size >= maxEntries ||
      characters + size > maxCharacters ||
      estimatedBytes + weight > maxEstimatedBytes
    ) {
      const oldest = entries.keys().next().value!;
      characters -= entries.get(oldest)!.size;
      estimatedBytes -= entries.get(oldest)!.weight;
      entries.delete(oldest);
      stats.evictions++;
    }
    entries.set(file, { source, prepared, size, weight });
    characters += size;
    estimatedBytes += weight;
  }
  return prepared;
}

export const kinds = ["pg", "reylo", "drizzle", "inline"] as const;
export type Kind = (typeof kinds)[number];
export interface Options {
  org: number;
  search?: string;
  email: boolean;
  limit: number;
}
export interface Row {
  id: number;
  name: string;
  email: string | null;
}
export interface Compiled {
  text: string;
  values: unknown[];
}
export const scenarios: { name: string; options: Options; rows: number }[] = [
  { name: "page-20", options: { org: 10, email: false, limit: 20 }, rows: 20 },
  { name: "filtered-20", options: { org: 10, search: "User %", email: true, limit: 20 }, rows: 20 },
  { name: "rows-1000", options: { org: 10, email: false, limit: 1000 }, rows: 1000 },
];
export function shape(o: Options) {
  return Number(!!o.search) * 2 + Number(o.email);
}
export function tableName(schema: string) {
  if (!/^reylo_bench_[a-f0-9]+$/.test(schema)) throw Error("Invalid benchmark schema");
  return `"${schema}"."users"`;
}
export function bindings(o: Options): unknown[] {
  return o.search ? [o.org, o.search, o.limit] : [o.org, o.limit];
}
export function raw(table: string, o: Options): Compiled {
  return {
    text: `SELECT id, name, email FROM ${table} WHERE (org_id = $1)${o.search ? " AND (name ILIKE $2)" : ""}${o.email ? " AND (email IS NOT NULL)" : ""} ORDER BY id LIMIT $${o.search ? 3 : 2}`,
    values: bindings(o),
  };
}
export function stats(samples: number[]) {
  if (!samples.length) throw Error("No samples");
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
  return { n: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0]!, max: sorted.at(-1)! };
}
export function rotate<T>(values: readonly T[], round: number): T[] {
  const start = round % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

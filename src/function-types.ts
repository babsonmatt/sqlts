import type { Catalog, SqlFunction } from "./catalog.ts";
export const unknownType = "SQL expression";
export function canonical(type: string): string {
  const clean = type.trim().replace(/\s*([.[\]])\s*/g, "$1");
  const array = clean.endsWith("[]");
  const base = array ? clean.slice(0, -2) : clean;
  return (
    ((
      {
        int: "integer",
        int4: "integer",
        int2: "smallint",
        int8: "bigint",
        bool: "boolean",
        float8: "double precision",
        float4: "real",
        varchar: "character varying",
      } as Record<string, string>
    )[base] ?? base) + (array ? "[]" : "")
  );
}
// Bind only provable polymorphic types. PostgreSQL still owns implicit coercions,
// overload ranking, domains and compatible-family common-supertype selection.
export function resolveFunctions(
  functions: SqlFunction[],
  args: string[],
  catalog: Catalog,
): SqlFunction[] {
  const exact = functions.filter(
    (f) => f.inputTypes.length === args.length && f.inputTypes.every((v, i) => v === args[i]),
  );
  if (exact.length) return exact;
  const resolved: SqlFunction[] = [];
  for (const f of functions) {
    if (
      args.length < f.inputTypes.length - (f.defaults ?? 0) - (f.variadic ? 1 : 0) ||
      (!f.variadic && args.length > f.inputTypes.length)
    )
      continue;
    const variables = new Map<string, string>();
    const blocked = new Set<string>();
    let valid = true;
    const bind = (key: string, value: string) => {
      if (value === unknownType) {
        blocked.add(key);
        return;
      }
      const prior = variables.get(key);
      if (prior && prior !== value) {
        blocked.add(key);
        return;
      }
      variables.set(key, value);
    };
    for (let i = 0; i < args.length; i++) {
      let expected = f.inputTypes[Math.min(i, f.inputTypes.length - 1)] ?? "";
      if (f.variadic && i >= f.inputTypes.length - 1) expected = f.variadic;
      const actual = args[i]!;
      const poly =
        /^any(?:compatible)?(?:element|array|nonarray|enum|range|multirange)$/.test(expected) ||
        expected === "anycompatible";
      if (!poly) {
        if (actual !== unknownType && expected !== actual) valid = false;
        continue;
      }
      const family = expected.startsWith("anycompatible") ? "compatible" : "simple";
      const info = catalog.types?.find((t) => t.name === actual);
      let element = actual;
      if (expected.endsWith("multirange")) {
        const range = info?.multirangeRange;
        element = catalog.types?.find((t) => t.name === range)?.rangeSubtype ?? unknownType;
        bind(family + "range", range ?? unknownType);
        bind(family + "multirange", actual);
      } else if (expected.endsWith("range")) {
        element = info?.rangeSubtype ?? unknownType;
        bind(family + "range", actual);
        bind(
          family + "multirange",
          catalog.types?.find((t) => t.multirangeRange === actual)?.name ?? unknownType,
        );
      } else if (expected.endsWith("array") && !expected.endsWith("nonarray")) {
        element = info?.element ?? (actual.endsWith("[]") ? actual.slice(0, -2) : unknownType);
        bind(family + "array", actual);
      }
      bind(family + "element", element);
    }
    if (!valid) continue;
    const substitute = (type: string): string => {
      const raw = type.replace(/^SETOF /, "");
      if (
        !/^any(?:compatible)?(?:element|array|nonarray|enum|range|multirange)$/.test(raw) &&
        raw !== "anycompatible"
      )
        return raw;
      const family = raw.startsWith("anycompatible") ? "compatible" : "simple";
      const suffix = raw.endsWith("multirange")
        ? "multirange"
        : raw.endsWith("range")
          ? "range"
          : raw.endsWith("array") && !raw.endsWith("nonarray")
            ? "array"
            : "element";
      const key = family + suffix;
      if (blocked.has(key) || blocked.has(family + "element")) return unknownType;
      return (
        variables.get(key) ??
        (suffix === "array" && variables.has(family + "element")
          ? variables.get(family + "element")! + "[]"
          : unknownType)
      );
    };
    const result = substitute(f.result);
    const type = catalog.types?.find((t) => t.name === result);
    const relation = catalog.relations.find(
      (r) => result === `${r.schema}.${r.name}` || (r.visible && result === r.name),
    );
    resolved.push({
      ...f,
      result,
      columns: f.columns.length
        ? f.columns.map((c) => ({ ...c, type: substitute(c.type) }))
        : (type?.columns ?? relation?.columns ?? []),
    });
  }
  return resolved;
}

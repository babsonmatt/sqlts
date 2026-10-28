import { expect, test } from "bun:test";
import { normalizeGeneratedType } from "../src/generated-types.ts";

test("generated nullable-unknown cleanup preserves other types and literal text", () => {
  expect(normalizeGeneratedType("{ value: unknown | null; nested: (null | unknown)[] }")).toBe(
    "{ value: unknown; nested: (unknown)[] }",
  );
  for (const type of [
    "string | null",
    "unknown[] | null",
    "unknown | any",
    '"unknown | null"',
    '{ "unknown | null": string | null }',
  ])
    expect(normalizeGeneratedType(type)).toBe(type);
});

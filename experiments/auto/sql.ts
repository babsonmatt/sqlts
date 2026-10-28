// Marker import for the isolated transform. Intentionally has no .auto member:
// direct/untransformed checking must fail instead of silently returning any.
import { createSql } from "../../src/runtime.ts";
export const sql = createSql<Record<never, never>>({});

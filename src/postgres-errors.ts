import type { PostgresQueryError as UpstreamError, PostgresNarrowing, TryResult } from "reylo";
import type { POSTGRES_CODES } from "./postgres-codes.ts";
// Preserve SQLTS's code/condition discrimination for closed statements. Upstream
// supplies the constraint fields and keeps statements running user code open.
export type NormalizeError<E> = E extends { code: infer C }
  ? string extends C
    ? E
    : {
        [K in C & keyof typeof POSTGRES_CODES]: Omit<E, "code" | "condition"> & {
          readonly code: K;
          readonly condition: (typeof POSTGRES_CODES)[K];
        };
      }[C & keyof typeof POSTGRES_CODES]
  : E;
export type PostgresQueryError<N extends PostgresNarrowing | undefined = undefined> =
  NormalizeError<UpstreamError<N>>;
export type QueryResult<T, E = PostgresQueryError> = TryResult<T, NormalizeError<E>>;

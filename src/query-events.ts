export interface QueryInfo {
  sql: string;
  source: string | undefined;
  cardinality: string;
}
export type QueryEvent = QueryInfo &
  (
    | { phase: "start"; id: number }
    | { phase: "end"; id: number; durationMs: number; rowCount: number }
    | { phase: "error"; id: number; durationMs: number; error: unknown }
  );
const listeners = new Set<(event: QueryEvent) => void>();
let sequence = 0;
/** Opt-in observation. Values/results are excluded; observer failures never alter a query. */
export function subscribeQueries(listener: (event: QueryEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function observeQuery<T>(info: QueryInfo, run: () => Promise<T[]>): Promise<T[]> {
  if (!listeners.size) return run();
  const observers = [...listeners];
  const id = ++sequence,
    start = performance.now();
  const emit = (event: QueryEvent) => {
    for (const listener of observers) {
      try {
        listener(Object.freeze(event));
      } catch {}
    }
  };
  emit({ ...info, phase: "start", id });
  const fail = (error: unknown): never => {
    emit({ ...info, phase: "error", id, durationMs: performance.now() - start, error });
    throw error;
  };
  try {
    return run().then((rows) => {
      emit({
        ...info,
        phase: "end",
        id,
        durationMs: performance.now() - start,
        rowCount: rows.length,
      });
      return rows;
    }, fail);
  } catch (error) {
    return Promise.reject().catch(() => fail(error));
  }
}

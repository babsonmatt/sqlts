import type { PostgresClient } from "reylo";

type Fields = Record<PropertyKey, unknown>;
const object = (value: unknown): value is Fields =>
  value !== null && (typeof value === "object" || typeof value === "function");
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Native command metadata, never inferred from the returned array's length. */
export function readExecutionMetadata(result: unknown) {
  if (!object(result)) return { affectedRows: null, command: null };
  const command = typeof result.command === "string" ? result.command : null;
  const writes = command !== null && /^(INSERT|UPDATE|DELETE|MERGE)(?:\s|$)/i.test(command);
  // pg/postgres.js command counts also count SELECT results. Only write command
  // counts belong in affectedRows. PGlite 0.4 exposes affectedRows without a tag.
  const affectedRows =
    command !== null
      ? writes
        ? (count(result.rowCount) ?? count(result.count) ?? count(result.affectedRows))
        : /^SELECT(?:\s|$)/i.test(command)
          ? 0
          : null
      : count(result.affectedRows);
  return { affectedRows, command };
}

/**
 * Observe a native result before Reylo decodes it, without changing the client,
 * running SQL twice, or replacing validation/encoding/decoding. Each invocation
 * owns its capture, including when queries share a pool or transaction.
 */
export async function captureExecution<Row>(
  client: PostgresClient,
  freshQuery: string | undefined,
  run: (client: PostgresClient) => Promise<Row[]>,
): Promise<{ rows: Row[]; affectedRows: number | null; command: string | null }> {
  let metadata: { affectedRows: number | null; command: string | null } = {
    affectedRows: null,
    command: null,
  };
  let selected = false;
  const wrappers = new WeakMap<object, object>();
  const statement = (args: unknown[]) => {
    const first = args[0];
    return typeof first === "string"
      ? first
      : object(first)
        ? typeof first.text === "string"
          ? first.text
          : typeof first.sql === "string"
            ? first.sql
            : undefined
        : undefined;
  };
  const call = (target: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) => {
    const sql = statement(args);
    const observe = !selected && sql !== undefined && sql !== freshQuery;
    if (observe) selected = true;
    const pending = Reflect.apply(target, receiver, args);
    if (!observe) return pending;
    const capture = (result: unknown) => {
      metadata = readExecutionMetadata(result);
      return result;
    };
    // postgres.js's raw() must be selected before awaiting. Eagerly attaching a
    // .then() here would execute it in the wrong mode (or execute it twice).
    return {
      // Intentional lazy PromiseLike: preserve the driver's raw-vs-object execution mode.
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve: (value: unknown) => unknown, reject: (cause: unknown) => unknown) =>
        Promise.resolve(pending).then(capture).then(resolve, reject),
      ...(object(pending) && typeof pending.raw === "function"
        ? {
            raw: (...rawArgs: unknown[]) =>
              Promise.resolve(
                Reflect.apply(pending.raw as (...args: unknown[]) => unknown, pending, rawArgs),
              ).then(capture),
          }
        : {}),
    };
  };
  const wrap = (source: unknown): unknown => {
    if (!object(source)) return source;
    const cached = wrappers.get(source);
    if (cached) return cached;
    // Proxy a separate target so frozen driver/session properties stay intact.
    const target =
      typeof source === "function"
        ? (...args: unknown[]) => call(source as (...args: unknown[]) => unknown, undefined, args)
        : {};
    const proxy = new Proxy(target, {
      get(_target, key) {
        const value = Reflect.get(source, key, source);
        if (["session", "client", "tx", "$client"].includes(String(key))) return wrap(value);
        if (typeof value !== "function") return value;
        if (["query", "unsafe", "result", "execute"].includes(String(key)))
          return (...args: unknown[]) =>
            call(value as (...args: unknown[]) => unknown, source, args);
        return value.bind(source);
      },
      has(_target, key) {
        return key in source;
      },
    });
    wrappers.set(source, proxy);
    return proxy;
  };
  const rows = await run(wrap(client) as PostgresClient);
  return { rows, ...metadata };
}

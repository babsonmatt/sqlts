import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

/** One signal per package; nested tsconfigs and the preview server share it. */
export function schemaSignal(from: string) {
  const start = resolve(from);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json")) || dirname(dir) === dir)
      return join(existsSync(join(dir, "package.json")) ? dir : start, ".sqlts-schema-revision");
  }
}
export function schemaRevision(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
/** Call after DDL completes, including manual recovery from partial migration failure.
 * Contains no connection details, SQL or source text. No database operation occurs here. */
export function refreshSchema(project: string) {
  const file = schemaSignal(project);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, randomUUID() + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return file;
}

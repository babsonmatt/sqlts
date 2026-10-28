import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { refreshSchema } from "../../src/sqlts/schema-refresh.ts";
export const dbmateVersion = "2.37.0";
export const dbmatePath = resolve(
  import.meta.dir,
  `../../work/tools/dbmate-${dbmateVersion}/dbmate`,
);
export async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command[0]!, command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += String(b);
  });
  child.stderr.on("data", (b) => {
    stderr += String(b);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  return { code, output: stdout + stderr, stdout, stderr };
}
/** Demo adapter: explicit environment and migrations directory, no schema dump or
 * implicit database creation. Signal even after failure: earlier migrations in a
 * batch (or nontransactional DDL) may already have committed. Never report that as success. */
export async function migrate(
  project: string,
  env: NodeJS.ProcessEnv,
  command: "migrate" | "rollback" = "migrate",
) {
  const result = await run(
    [
      dbmatePath,
      "--env-file",
      ".dbmate-no-env",
      "--env",
      "SQLTS_DBMATE_DATABASE_URL",
      "--migrations-dir",
      resolve(project, "db/migrations"),
      "--migrations-table",
      "schema_migrations",
      "--no-dump-schema",
      "--migration-lock",
      "--migration-lock-timeout",
      "10s",
      command,
      ...(command === "migrate" ? ["--strict"] : []),
    ],
    project,
    env,
  );
  refreshSchema(project);
  return result;
}

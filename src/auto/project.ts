import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../scripts/generate.ts";
import { diagnose, type SqlDiagnostic } from "../diagnostics.ts";
import { tooling } from "../adapter/reylo.ts";
import { originalRange, transformAuto, type AutoFile } from "./transform.ts";
export const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultProject = resolve(codeRoot, "experiments/auto");
export interface Snapshot {
  root: string;
  directory: string;
  files: AutoFile[];
  artifact: string;
  created: string;
}
export interface AutoError {
  file: string;
  diagnostic: SqlDiagnostic;
}
export class AutoGenerationError extends Error {
  constructor(readonly diagnostics: AutoError[]) {
    super(diagnostics.map((d) => `${d.file}: ${d.diagnostic.message}`).join("\n"));
  }
}
export async function buildAuto(
  root = defaultProject,
  documents: Record<string, string> = {},
  snapshotParent?: string,
): Promise<Snapshot> {
  root = resolve(root);
  const paths = (
    await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: root, onlyFiles: true }))
  ).filter(
    (p) => !p.split("/").some((v) => v.startsWith(".") || v === "node_modules") && p !== "sql.ts",
  );
  for (const path of Object.keys(documents)) {
    const name = relative(root, path);
    if (
      isAbsolute(name) ||
      name.startsWith("..") ||
      name.split("/").some((v) => v.startsWith(".")) ||
      !name.endsWith(".ts") ||
      name === "sql.ts"
    )
      continue;
    if (!paths.includes(name)) paths.push(name);
  }
  if (paths.length > 64) throw Error("Auto experiment is limited to 64 TypeScript source files");
  const snapshots = snapshotParent ?? resolve(root, ".auto/snapshots");
  await mkdir(snapshots, { recursive: true });
  const directory = await mkdtemp(resolve(snapshots, "build-")),
    artifact = resolve(directory, ".inline/sql.ts");
  try {
    const files: AutoFile[] = [];
    for (const name of paths.sort()) {
      const original = resolve(root, name),
        shadow = resolve(directory, name);
      const source = documents[original] ?? (await readFile(original, "utf8"));
      if (source.length > 500_000) throw Error(`${original}: auto source exceeds 500 KB`);
      const transformed = transformAuto(source, original, shadow, root, artifact);
      files.push(transformed);
      await mkdir(dirname(shadow), { recursive: true });
      await writeFile(shadow, transformed.text);
    }
    const queries = files.filter((f) => f.ids.length);
    if (!queries.length) throw Error("No experimental sql.auto query sites found");
    try {
      await generate(
        queries.map((f) => f.shadow),
        artifact,
      );
    } catch (error) {
      const handlers = tooling.mapperHandlers(),
        projectHandle = "auto-errors-" + crypto.randomUUID(),
        errors: AutoError[] = [];
      try {
        await handlers.openProject({
          projectHandle,
          configFileName: resolve(codeRoot, "tsconfig.json"),
        });
        for (const file of queries)
          for (const diagnostic of await diagnose(file.text, file.shadow, handlers, projectHandle))
            errors.push({
              file: file.original,
              diagnostic: { ...diagnostic, range: originalRange(file, diagnostic.range) },
            });
      } finally {
        await handlers.closeProject({ projectHandle });
        await tooling.releaseConnections();
      }
      if (errors.length) throw new AutoGenerationError(errors);
      throw error;
    }
    const base = JSON.parse(await readFile(resolve(codeRoot, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    await writeFile(
      resolve(directory, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: base.compilerOptions,
          files: [...files.map((f) => relative(directory, f.shadow)), ".inline/sql.ts"],
        },
        null,
        2,
      ),
    );
    const snapshot: Snapshot = {
      root,
      directory,
      files,
      artifact,
      created: new Date().toISOString(),
    };
    await writeFile(resolve(directory, "snapshot.json"), JSON.stringify(snapshot));
    // CLI builds publish only after generation succeeds. Editor snapshots never replace this pointer.
    return snapshot;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function publishAuto(snapshot: Snapshot) {
  const target = resolve(snapshot.root, ".auto/current.json"),
    temp = target + "." + crypto.randomUUID();
  await writeFile(temp, JSON.stringify({ directory: snapshot.directory }, null, 2) + "\n");
  await rename(temp, target);
}
export async function removeAuto(snapshot: Snapshot) {
  await rm(snapshot.directory, { recursive: true, force: true });
}
export function mapCheckOutput(output: string, snapshot: Snapshot) {
  for (const file of snapshot.files) {
    // Bun emits either relative or absolute filenames; preserve exact source positions.
    const escaped = relative(snapshot.directory, file.shadow).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    output = output.replace(
      new RegExp(
        `(?:${snapshot.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/)?${escaped}\\((\\d+),(\\d+)\\)`,
        "g",
      ),
      (_m, line, col) => {
        const range = originalRange(file, {
          start: { line: Number(line) - 1, character: Number(col) - 1 },
          end: { line: Number(line) - 1, character: Number(col) - 1 },
        });
        return `${file.original}(${range.start.line + 1},${range.start.character + 1})`;
      },
    );
  }
  return output;
}

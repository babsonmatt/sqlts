import ts from "typescript-ast";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Saved source dependencies are dynamic mapper configuration. A changed identity
 * invalidates the compiler's cached transforms without editing consumer files. */
export function projectDependencies(configFile: string) {
  const entries = new Map<string, string>();
  const snapshots = new Map<string, string>();
  const read = (file: string): string | undefined => {
    try {
      const text = readFileSync(file, "utf8");
      snapshots.set(resolve(file), createHash("sha256").update(text).digest("hex"));
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        snapshots.set(resolve(file), "unreadable:ENOENT");
        return undefined;
      }
      throw error;
    }
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configFile,
    {},
    {
      ...ts.sys,
      getCurrentDirectory: () => dirname(configFile),
      readFile(file) {
        const text = read(file);
        entries.set(resolve(file), text ?? "<missing>");
        return text;
      },
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
    undefined,
    undefined,
    [{ extension: ".sqlts", isMixedContent: false, scriptKind: ts.ScriptKind.TS }],
  );
  const visited = new Set<string>();
  const visit = (file: string) => {
    file = resolve(file);
    if (visited.has(file)) return;
    visited.add(file);
    const content = read(file);
    const imports =
      content === undefined
        ? []
        : ts
            .preProcessFile(content, true)
            .importedFiles.map((item) => item.fileName)
            .filter((name) => name.startsWith("."));
    // Ordinary TS bodies do not affect shared SQL expansion. Their import graph
    // does: follow local wrappers too, including queries outside config includes.
    entries.set(file, file.endsWith(".sqlts") ? (content ?? "<missing>") : JSON.stringify(imports));
    for (const name of imports) {
      if (name.endsWith(".sqlts")) visit(resolve(dirname(file), name));
      else {
        const target = ts.resolveModuleName(
          name,
          file,
          parsed?.options ?? {},
          ts.sys,
        ).resolvedModule;
        if (target && !target.isExternalLibraryImport && !target.resolvedFileName.endsWith(".d.ts"))
          visit(target.resolvedFileName);
      }
    }
  };
  for (const file of parsed?.fileNames ?? []) if (!file.endsWith(".d.ts")) visit(file);
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b));
  return {
    watchedFiles: sorted.map(([file]) => file),
    snapshots,
    identity: createHash("sha256").update(JSON.stringify(sorted)).digest("hex"),
  };
}

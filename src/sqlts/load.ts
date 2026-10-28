import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { analyze, tooling } from "./analyze.ts";
import { prepareCached } from "./prepared-cache.ts";
import ts from "typescript-ast";
export async function loadSqlts(file: string, watchFile?: (file: string) => void) {
  let directory = dirname(file),
    config: string | undefined;
  while (true) {
    const candidate = resolve(directory, "tsconfig.json");
    try {
      await access(candidate);
      config = candidate;
      break;
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!config) throw Error(`${file}: no tsconfig.json found`);
  const handlers = tooling.mapperHandlers(),
    projectHandle = "sqlts-runtime-" + crypto.randomUUID();
  try {
    const project = await handlers.openProject({ projectHandle, configFileName: config });
    watchFile?.(config);
    for (const path of project.watchedFiles) watchFile?.(path);
    const content = await readFile(file, "utf8");
    if (watchFile)
      for (const path of Object.keys(prepareCached(content, file).fingerprints ?? {}))
        watchFile(path);
    const result = await analyze({ projectHandle, fileName: file, content }, handlers);
    return ts.transpileModule(result.runtime, {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText;
  } finally {
    await handlers.closeProject({ projectHandle });
    await tooling.releaseConnections();
  }
}

// Tooling owns shared connections. Serialize bundler requests across plugin instances.
let pending: Promise<unknown> = Promise.resolve();
export function queuedLoadSqlts(file: string, watchFile?: (file: string) => void): Promise<string> {
  const next = pending.then(() => loadSqlts(file, watchFile));
  pending = next.catch(() => {});
  return next;
}

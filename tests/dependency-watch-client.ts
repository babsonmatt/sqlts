import { watch, existsSync, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { client } from "./lsp-client.ts";

/** Emulate the editor forwarding the compiler's registered signal-file watches. */
export function dependencyClient(
  options: { command?: string[]; cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const watchers = new Map<string, FSWatcher>();
  let notifications = 0;
  const lsp = client(
    options.command ?? [Bun.which("node")!, "node_modules/typescript/bin/tsc", "--lsp", "--stdio"],
    {
      DATABASE_URL: process.env.DATABASE_URL,
      ...options.env,
    },
    undefined,
    (method, params) => {
      if (method !== "client/registerCapability") return;
      const registrations = (
        params as {
          registrations: {
            registerOptions?: {
              watchers?: { globPattern: string | { baseUri: string; pattern: string } }[];
            };
          }[];
        }
      ).registrations;
      for (const registration of registrations)
        for (const item of registration.registerOptions?.watchers ?? []) {
          const pattern = item.globPattern;
          if (typeof pattern !== "string" || !pattern.includes("reylo-sqlts-watch-")) continue;
          const directory = pattern.split("/**")[0]!;
          if (watchers.has(directory) || !existsSync(directory)) continue;
          const file = join(directory, "saved-dependencies.json");
          let previous = readFileSync(file, "utf8");
          const watcher = watch(directory, { persistent: false }, () => {
            if (!existsSync(file)) return;
            const text = readFileSync(file, "utf8");
            if (text === previous) return;
            previous = text;
            notifications++;
            lsp.notify("workspace/didChangeWatchedFiles", {
              changes: [{ uri: pathToFileURL(file).href, type: 2 }],
            });
          });
          watchers.set(directory, watcher);
        }
    },
    options.cwd,
  );
  return {
    ...lsp,
    get registrations() {
      return watchers.size;
    },
    get notifications() {
      return notifications;
    },
    async close() {
      for (const watcher of watchers.values()) watcher.close();
      await lsp.close();
    },
  };
}

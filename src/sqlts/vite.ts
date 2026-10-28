import type { Plugin } from "vite";
import { queuedLoadSqlts } from "./load.ts";
/** Vite server/SSR modules. Queries are never automatically exposed to browser bundles. */
export default function sqlts(): Plugin {
  const dependencies = new Map<string, Set<string>>();
  return {
    name: "sqlts",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".sqlts")) return;
      if (this.environment.config.consumer !== "server")
        throw new Error("SQLTS queries belong in server/SSR modules, not the browser bundle");
      const watched = new Set<string>([id]);
      dependencies.set(id, watched);
      const code = await queuedLoadSqlts(id, (file) => {
        watched.add(file);
        this.addWatchFile(file);
      });
      return { code, map: null };
    },
    handleHotUpdate(ctx) {
      const affected = new Set(ctx.modules);
      for (const [id, files] of dependencies) {
        if (!files.has(ctx.file)) continue;
        const module = ctx.server.moduleGraph.getModuleById(id);
        if (module) {
          ctx.server.moduleGraph.invalidateModule(module);
          affected.add(module);
        }
      }
      return [...affected];
    },
  };
}

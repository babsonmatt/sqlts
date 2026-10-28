import type { Plugin } from "esbuild";
import { dirname } from "node:path";
import { queuedLoadSqlts } from "./load.ts";
/** Server builds only. Run the SQL-aware checker separately before bundling. */
export default function sqlts(): Plugin {
  return {
    name: "sqlts",
    setup(build) {
      if (build.initialOptions.platform !== "node")
        throw new Error("SQLTS esbuild integration requires platform: 'node'");
      build.onLoad({ filter: /\.sqlts$/ }, async ({ path }) => {
        const watchFiles = new Set<string>([path]);
        return {
          contents: await queuedLoadSqlts(path, (file) => watchFiles.add(file)),
          loader: "js",
          resolveDir: dirname(path),
          watchFiles: [...watchFiles],
        };
      });
    },
  };
}

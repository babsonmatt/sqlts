if (typeof Bun !== "undefined") {
  const { loadSqlts } = await import("./load.ts");
  // Imports may load concurrently; the pinned analyzer owns shared native sessions.
  let pending: Promise<unknown> = Promise.resolve();
  Bun.plugin({
    name: "reylo-sqlts",
    setup(build) {
      build.onLoad({ filter: /\.sqlts$/ }, (args) => {
        const result = pending.then(async () => ({
          loader: "js" as const,
          contents: await loadSqlts(args.path),
        }));
        pending = result.catch(() => {});
        return result;
      });
    },
  });
} else {
  const { registerHooks } = await import("node:module");
  const { fileURLToPath } = await import("node:url");
  const { loadSync } = await import("./node-bridge.ts");
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !new URL(url).pathname.endsWith(".sqlts"))
        return nextLoad(url, context);
      return { format: "module", source: loadSync(fileURLToPath(url)), shortCircuit: true };
    },
  });
}
export {};

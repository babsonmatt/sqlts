import { resolve } from "node:path";
import { loadSqlts } from "./load.ts";

/** Optional deployment build. Development still uses the in-memory loader. */
export async function buildSqlts(entry: string, outfile: string) {
  if (typeof Bun === "undefined")
    throw Error("The optional deployment bundler requires Bun; its output runs on Node or Bun");
  const result = await Bun.build({
    entrypoints: [resolve(entry)],
    target: "node",
    format: "esm",
    minify: false,
    packages: "external",
    sourcemap: "none",
    plugins: [
      {
        name: "sqlts-deployment",
        setup(build) {
          let pending: Promise<unknown> = Promise.resolve();
          build.onLoad({ filter: /\.sqlts$/ }, (args) => {
            const next = pending.then(async () => ({
              loader: "js" as const,
              contents: await loadSqlts(args.path),
            }));
            pending = next.catch(() => {});
            return next;
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "SQLTS deployment build failed");
  if (result.outputs.length !== 1) throw Error("Expected one deployment module");
  // Native analysis, compilers and source checkout paths must never enter the request bundle.
  const output = await result.outputs[0]!.text();
  if (/@reylosql\/postgres|typescript-ast|mapperHandlers|loadSqlts/.test(output))
    throw Error("Analyzer leaked into deployment output");
  await Bun.write(resolve(outfile), output);
  return { file: resolve(outfile), bytes: Buffer.byteLength(output) };
}

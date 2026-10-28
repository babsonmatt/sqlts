import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadSqlts } from "./load.ts";

/**
 * Optional deployment build. Development still uses the in-memory loader.
 * Under Bun this uses Bun.build; under Node it uses esbuild (an optional peer dependency).
 * Either way the output runs on Node or Bun.
 */
export async function buildSqlts(entry: string, outfile: string) {
  const output = typeof Bun !== "undefined" ? await bunBuild(entry) : await esbuildBuild(entry);
  // Native analysis, compilers and source checkout paths must never enter the request bundle.
  if (/@reylosql\/postgres|typescript-ast|mapperHandlers|loadSqlts/.test(output))
    throw Error("Analyzer leaked into deployment output");
  await mkdir(dirname(resolve(outfile)), { recursive: true });
  await writeFile(resolve(outfile), output);
  return { file: resolve(outfile), bytes: Buffer.byteLength(output) };
}

async function bunBuild(entry: string) {
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
  return result.outputs[0]!.text();
}

async function esbuildBuild(entry: string) {
  let esbuild: typeof import("esbuild");
  try {
    esbuild = await import("esbuild");
  } catch {
    throw Error(
      "sqlts build on Node needs esbuild installed (npm i -D esbuild), or run it with Bun",
    );
  }
  const { default: sqlts } = await import("./esbuild.ts");
  const result = await esbuild.build({
    entryPoints: [resolve(entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    logLevel: "silent",
    plugins: [sqlts()],
  });
  if (result.outputFiles.length !== 1) throw Error("Expected one deployment module");
  return result.outputFiles[0]!.text;
}

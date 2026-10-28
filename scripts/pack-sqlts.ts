import { mkdir, mkdtemp, readFile, writeFile, readdir, chmod } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript-ast";
const root = resolve(import.meta.dir, "..");
const base = resolve(root, "work/packages");
await mkdir(base, { recursive: true });
const stage = await mkdtemp(resolve(base, "sqlts-"));
const rewrite = (text: string) => text.replace(/(\.\.?\/[^\s"'`]+)\.ts(["'`])/g, "$1.js$2");
async function compileTree(directory: string) {
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) await compileTree(path);
    else if (entry.name.endsWith(".ts")) {
      const text = await readFile(resolve(root, path), "utf8");
      const output = ts.transpileModule(text, {
        fileName: path,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText;
      const destination = resolve(stage, path.replace(/\.ts$/, ".js"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, rewrite(output));
    }
  }
}
await compileTree("src");
await mkdir(resolve(stage, "scripts"), { recursive: true });
for (const script of ["preview-server", "catalog-worker", "diagnostics-worker"]) {
  const source = await readFile(resolve(root, `scripts/${script}.ts`), "utf8");
  await writeFile(
    resolve(stage, `scripts/${script}.js`),
    rewrite(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText,
    ),
  );
}
await mkdir(resolve(stage, "editors/zed"), { recursive: true });
await writeFile(
  resolve(stage, "editors/zed/server.bunfig.toml"),
  await readFile(resolve(root, "editors/zed/server.bunfig.toml")),
);
await writeFile(resolve(stage, "tag.js"), "export const sql = undefined;\n");
await writeFile(resolve(stage, "tag.d.ts"), "export declare const sql: never;\n");
const options: ts.CompilerOptions = {
  declaration: true,
  emitDeclarationOnly: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  types: ["bun"],
  outDir: resolve(stage, "src"),
  rootDir: resolve(root, "src"),
};
const program = ts.createProgram(
  [
    "src/runtime.ts",
    "src/sqlts/build.ts",
    "src/sqlts/esbuild.ts",
    "src/sqlts/vite.ts",
    "src/tracing.ts",
  ].map((file) => resolve(root, file)),
  options,
);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length)
  throw Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (f) => f,
      getNewLine: () => "\n",
    }),
  );
program.emit(undefined, (file, text) => {
  writeFileSync(file, rewrite(text));
});
await writeFile(
  resolve(stage, "package.json"),
  JSON.stringify(
    {
      name: "@sqlts/core",
      version: "0.1.1",
      description:
        "Write PostgreSQL in TypeScript and keep inferred types, with SQL-aware checking.",
      keywords: ["sql", "postgres", "postgresql", "typescript", "types", "query", "reylo"],
      homepage: "https://sqlts.dev",
      repository: { type: "git", url: "git+https://github.com/babsonmatt/sqlts.git" },
      bugs: { url: "https://github.com/babsonmatt/sqlts/issues" },
      license: "MIT",
      publishConfig: { access: "public" },
      type: "module",
      exports: {
        ".": { types: "./tag.d.ts", default: "./tag.js" },
        "./register": "./src/sqlts/register.js",
        "./build": "./src/sqlts/build.js",
        "./esbuild": { types: "./src/sqlts/esbuild.d.ts", default: "./src/sqlts/esbuild.js" },
        "./vite": { types: "./src/sqlts/vite.d.ts", default: "./src/sqlts/vite.js" },
        "./tracing": { types: "./src/tracing.d.ts", default: "./src/tracing.js" },
        "./runtime": { types: "./src/runtime.d.ts", default: "./src/runtime.js" },
      },
      // npm publish rejects bin paths with a leading "./".
      bin: {
        sqlts: "src/sqlts/cli.js",
        "reylo-inline-preview": "src/sqlts/preview-cli.js",
      },
      typescript: {
        contentMapper: {
          compilerOptions: [],
          dynamicConfig: true,
          exec: ["node", "src/sqlts/mapper.js"],
        },
      },
      dependencies: {
        "typescript-ast": "npm:typescript@5.9.3",
        pg: "8.23.1",
      },
      peerDependencies: {
        reylo: "~0.6.0",
        "@reylosql/postgres": "~0.6.0",
        typescript: "7.1.0-beta",
        esbuild: ">=0.25.0",
        vite: "^8.0.0",
      },
      peerDependenciesMeta: { esbuild: { optional: true }, vite: { optional: true } },
      engines: { node: ">=25.2.1" },
    },
    null,
    2,
  ),
);
await writeFile(
  resolve(stage, "README.md"),
  await readFile(resolve(root, "experiments/sqlts/README.md"), "utf8"),
);
await writeFile(
  resolve(stage, "PORTABILITY.md"),
  await readFile(resolve(root, "experiments/sqlts/PORTABILITY.md"), "utf8"),
);
await writeFile(resolve(stage, "LICENSE"), await readFile(resolve(root, "LICENSE"), "utf8"));
// Some packaged files are copied from Reylo (see vendor/reylo/README.md); keep its license with them.
await writeFile(
  resolve(stage, "LICENSE-reylo"),
  await readFile(resolve(root, "vendor/reylo/LICENSE"), "utf8"),
);
await chmod(resolve(stage, "src/sqlts/cli.js"), 0o755);
await chmod(resolve(stage, "scripts/preview-server.js"), 0o755);
await chmod(resolve(stage, "src/sqlts/preview-cli.js"), 0o755);
const child = Bun.spawn(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", base], {
  cwd: stage,
  stdout: "pipe",
  stderr: "pipe",
});
const [code, out, err] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
if (code) throw Error(err);
const packed = JSON.parse(out) as { filename: string }[];
// Reylo comes from npm (peer dependencies above); there are no companion tarballs.
console.log(JSON.stringify({ directory: stage, tarball: resolve(base, packed[0]!.filename) }));

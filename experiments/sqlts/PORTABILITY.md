# Local installation and deployment

SQLTS is published to npm as `@sqlts/core`. To test an unreleased change, `bun run sqlts:pack`
builds the same package as a tarball under `work/packages/`. The package includes JavaScript
implementation files and declarations; it does not refer back to this checkout. Node does not need
to execute TypeScript from inside `node_modules`.

## Another project

Install `@sqlts/core` with the project's package manager, together with `reylo@0.6` and
`@reylosql/postgres@0.6`, `typescript@7.1.0-beta`, the application's driver (`pg` in our tests), and
its normal Node/driver type packages:

```sh
npm install @sqlts/core reylo@0.6 @reylosql/postgres@0.6 pg
npm install -D typescript@7.1.0-beta @types/node @types/pg
```

To try a local build instead, install the tarball printed by `bun run sqlts:pack` in place of
`@sqlts/core`.

SQLTS uses Reylo internals and accepts only Reylo 0.6.x; both Reylo packages must be the same
version. The analyzer is a WebAssembly artifact shipped by `@reylosql/postgres`; installing these
packages does not compile Rust. Tested on macOS arm64, Node 25.2.1 and Bun 1.4.4-canary.

Configure the same `contentMappers` entry shown in README.md and include the query files
and callers in the actual tsconfig. Load the development DATABASE_URL using the application's
usual environment configuration. Then:

```
npx tsc --noEmit --runExternalCode -p tsconfig.json
node --import @sqlts/core/register app.ts
# or
bun --preload @sqlts/core/register app.ts
```

The check is the project's own TypeScript 7.1 beta `tsc`. `--runExternalCode` lets it run the
content mapper; TypeScript accepts that flag only on the command line, not in tsconfig.json.
`npx sqlts check -p tsconfig.json` is an optional shortcut that adds `--noEmit` and
`--runExternalCode` for you.

Checking and loader-based execution analyze SQL against the development database.
Analysis runs at module loading, not for every request. No generated source directory is
required. Runtime parameter checking, row decoding and Reylo's periodic schema-freshness
checks still apply to executed queries.

## Optional `bun check` shortcut

In an application with `@sqlts/core` installed, merge these scripts into
its `package.json` (preserving any existing checks):

```json
{
  "scripts": {
    "check:sql": "tsc --noEmit --runExternalCode -p tsconfig.json",
    "check": "bun run check:sql"
  }
}
```

Run `bun check` or `bun run check`. On the tested Bun 1.4.4, both invoke the project
script, which runs the native TypeScript compiler with `--noEmit` and
`--runExternalCode`; SQL errors, argument errors, result-property errors, and
saved shared-fragment errors fail the command with a nonzero exit status.
No separate generation command is required. Database configuration and the
mapper-enabled tsconfig are still required; use the application's existing environment
loading. Bun loads the application's normal `.env` configuration for its script.

This is command convenience, not a Bun-checker backend or a speed optimization.
Do not replace it with `bun check --no-script`: that explicitly bypasses the script
and invokes Bun's built-in checker, which does not run content mappers on this toolchain.
Other tools' built-in checking options do not automatically use this script either.
The source checkout already has a broader `bun check` suite including SQLTS checks;
keep that existing script. Add `bun run check:sql` to an application's current check
pipeline instead of discarding its lint/tests.

## Optional production build

Keep the loader workflow for development. For deployment, first run the SQL-aware checker,
then build using a database containing the intended schema:

```
npx sqlts build app.ts dist/app.mjs   # Node: bundles with esbuild (npm i -D esbuild)
bunx --bun sqlts build app.ts dist/app.mjs  # Bun: bundles with Bun.build
node dist/app.mjs
```

Both produce the same kind of module. Projects with their own esbuild or Vite build can use
`@sqlts/core/esbuild` or `@sqlts/core/vite` instead (below).

In this source checkout the equivalent build command is:

```
bun run sqlts:build experiments/shared-queries/consumer.ts work/shared-demo.mjs
```

This is explicitly an optional build step. It analyzes `.sqlts` modules at build time,
bundles their runtime SQL metadata, and leaves installed packages external. The produced
ES module runs on Node or Bun without the SQLTS loader, TypeScript or SQL analyzer.
Install the `reylo` 0.6.x runtime, the application's driver, and any other application runtime dependencies
in production. The production database is still necessary to execute queries. Reylo's
freshness checks are retained and can reject an incompatible deployed schema.

The bundler is not a typechecker; the check command is a required CI step. Runtime exception
stacks do not yet map back through the SQLTS transform. Cloudflare and other edge deployment
adapters remain unverified; this is not a promise of support for every runtime.

The package regression test installs the tarball outside the checkout, checks and runs it
on Node/Bun, then copies its bundle into a second project with only Reylo and pg. That second
project executes a real query without the SQLTS package or TypeScript AST library installed.
Bundle startup/compile is also checked with an unreachable development DATABASE_URL.

## Editor setup

Types and SQL errors in the editor come from TypeScript 7's own language server with the
content mapper enabled; no extension is needed for those. Point the editor at the project's
`node_modules/typescript/bin/tsc --lsp --stdio`, pass `runExternalCode: true` as an
initialization option, and treat `.sqlts` files as TypeScript.

SQL coloring, table/column completion and query previews come from a second language server,
`sqlts-preview` (`reylo-inline-preview` is the earlier name of the same command). It runs on
Node by default; pass `--runtime bun` to run it on Bun. Either way it does not run the
application's preload hooks, reads the development database from the environment, `.env.local`,
`.env` or `.reylo.yaml`'s `direct_url`, and never imports application code:

```sh
npx sqlts-preview --project /absolute/path/to/application
npx sqlts-preview --runtime bun --project /absolute/path/to/application
```

### Zed

Install the SQLTS extension (`editors/zed` in the source repository; until it is listed in
Zed's extension registry, run `zed: install dev extension` on that directory). It starts the
project's installed `@sqlts/core` preview server with Node, or with Bun when configured. Then
add to the project's `.zed/settings.json`, merging with existing settings:

```json
{
  "file_types": { "TypeScript": ["sqlts"] },
  "languages": {
    "TypeScript": {
      "language_servers": ["sqlts", "typescript-ls", "..."],
      "semantic_tokens": "combined"
    },
    "TSX": { "language_servers": ["sqlts", "typescript-ls", "..."], "semantic_tokens": "combined" }
  },
  "lsp": {
    "typescript-ls": {
      "binary": { "path": "node_modules/typescript/bin/tsc", "arguments": ["--lsp", "--stdio"] },
      "initialization_options": { "runExternalCode": true }
    },
    "sqlts": { "settings": { "runtime": "node" } }
  }
}
```

`"runtime": "bun"` runs the preview server on Bun. The `sqlts` entry is optional when using Node.
Restart the language servers after changing these settings.

### Other editors

Any editor that can run TypeScript 7's language server with `runExternalCode` gets types and
SQL errors. Any LSP client can also start `sqlts-preview --project <root>` over stdio for
coloring (semantic tokens), completion and previews. VS Code and Cursor need a small extension
to launch it; none is published yet.

## Schema changes and migration tools

SQLTS works with SQL migration runners such as dbmate. After applying schema changes,
run `sqlts refresh-schema --project /path/to/application`, then a fresh SQL-aware
check. The refresh command performs no DDL; it writes an ignored revision signal watched
by both editor services. It reloads completion metadata and replaces the native mapper's
analysis worker to discard stale in-memory schema information. It does not delete Reylo's
disk cache or generate query source. Existing editor processes need one restart after
installing this implementation. On a failed migration batch, refresh too: some migrations
may already have committed, but preserve and report the failure status.

Add `.sqlts-schema-revision` and `.sqlts-schema-revision.*.tmp` to the application's
ignore file. Use the nearest package root; nested tsconfigs share that signal. The
migration runner and Reylo's effective `direct_url` must target the same database.
The isolated checkout demo is documented in `experiments/dbmate/README.md`.

## Vite SSR and esbuild

The SQLTS package exports `@sqlts/core/vite` and
`@sqlts/core/esbuild`. Both are default plugin factories. Install your
bundler separately; it is an optional peer dependency.

```ts
// vite.config.ts — Vite 8 server/SSR code only
import { defineConfig } from "vite";
import sqlts from "@sqlts/core/vite";
export default defineConfig({ plugins: [sqlts()] });
```

The adapter watches shared fragments and invalidates server consumers after edits.
Browser imports are rejected. This is a server integration, distinct from our custom
PGlite browser playground.

```ts
import { build } from "esbuild";
import sqlts from "@sqlts/core/esbuild";
await build({
  entryPoints: ["src/app.ts"],
  outfile: "dist/app.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  plugins: [sqlts()],
});
```

The SQL-aware check remains a separate required step. Tests cover esbuild 0.28.2,
Vite 8.3.5 SSR builds and shared-file reload, plus execution of their output on Node.
They do not certify Next.js, webpack, Rspack, or Cloudflare application deployment.
Runtime stack source maps remain a separate limitation.

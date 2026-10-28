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
node node_modules/@sqlts/core/src/sqlts/cli.js check -p tsconfig.json
node --import @sqlts/core/register app.ts
# or
bun --preload @sqlts/core/register app.ts
```

Checking and loader-based execution analyze SQL against the development database.
Analysis runs at module loading, not for every request. No generated source directory is
required. Runtime parameter checking, row decoding and Reylo's periodic schema-freshness
checks still apply to executed queries.

## Optional `bun check` shortcut

In an application with the private SQLTS package installed, merge these scripts into
its `package.json` (preserving any existing checks):

```json
{
  "scripts": {
    "check:sql": "sqlts check -p tsconfig.json",
    "check": "bun run check:sql"
  }
}
```

Run `bun check` or `bun run check`. On the tested Bun 1.4.4, both invoke the project
script. The installed SQLTS CLI runs the native TypeScript compiler with `--noEmit`
and `--runExternalCode`; SQL errors, argument errors, result-property errors, and
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
then build with Bun using a database containing the intended schema:

```
bun node_modules/@sqlts/core/src/sqlts/cli.js build app.ts dist/app.mjs
node dist/app.mjs
```

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

The package includes `reylo-inline-preview` as a Node launcher for Bun, its catalog and diagnostic workers, and the isolated Bun configuration used by those workers. Configure it with
`--project /absolute/path/to/the/application` for SQL colors/catalog completion. Use the
application's installed native TypeScript server with `initialization_options.runExternalCode`
for SQL checking and inferred types, and associate `sqlts` with TypeScript.

Existing Zed grammar/extension installation is still a separate step. This tarball does
not install or publish a Zed extension. Separate-project tests verify native inferred hovers, saved-helper diagnostic refresh, SQL call previews, SQL coloring, and actual table/column completions from the installed tarball;
we have not claimed a fresh-machine graphical Zed installation test.

The installed preview launcher supplies an isolated Bun configuration, so starting the
editor does not run the application's preload hooks. Its workers read the configured
development database without importing application code. A tested command is:

```sh
node node_modules/@sqlts/core/src/sqlts/preview-cli.js --project /absolute/path/to/application
```

For Zed, merge equivalent binary overrides into the existing registered servers:

```json
{
  "file_types": { "TypeScript": ["sqlts"] },
  "lsp": {
    "typescript-ls": {
      "binary": { "path": "node_modules/typescript/bin/tsc", "arguments": ["--lsp", "--stdio"] },
      "initialization_options": { "runExternalCode": true }
    },
    "reylo-inline-preview": {
      "binary": {
        "path": "node_modules/.bin/reylo-inline-preview",
        "arguments": ["--project", "/absolute/path/to/application"]
      }
    }
  }
}
```

The registered SQL preview extension is still required. Preserve the application's
existing language-server selection and SQL coloring configuration; these overrides
do not install an extension or replace the rest of the user's Zed settings.

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
  entryPoints: ["src/app.ts"], outfile: "dist/app.mjs",
  bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [sqlts()],
});
```

The SQL-aware check remains a separate required step. Tests cover esbuild 0.28.2,
Vite 8.3.5 SSR builds and shared-file reload, plus execution of their output on Node.
They do not certify Next.js, webpack, Rspack, or Cloudflare application deployment.
Runtime stack source maps remain a separate limitation.

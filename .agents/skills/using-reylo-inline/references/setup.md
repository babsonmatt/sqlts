# Local .sqlts setup

Use this for the current prototype, not as a published-package installation guide. Resolve paths from the actual checkout and compare with `experiments/sqlts/README.md`, its tsconfig, the root package scripts, and existing `.zed/settings.json` files. Preserve working settings and other workflows.

## 1. Package and compiler

The checkout links `@sqlts/core` through its Bun workspace at `experiments/sqlts/plugin`. If dependencies are missing and setup is requested, install from the checkout root with its existing lockfile (`bun install --frozen-lockfile`). Do not reinstall for an ordinary query edit.

The verified compiler is the checkout's `typescript@7.1.0-beta`, with Reylo `0.6.x`; use the pinned toolchain rather than a global compiler or an untested upgrade. Node and Bun run this workflow, but Bun's built-in checker does not run content mappers on this toolchain.

For a separate repository, install `@sqlts/core` from npm with `reylo@0.6` and `@reylosql/postgres@0.6`, or run `bun run sqlts:pack` in this checkout and install the exact local tarball it prints to test unreleased changes. Copying just `experiments/sqlts/plugin` is insufficient. Install `typescript@7.1.0-beta`, the app's driver and Node/driver type packages. See `experiments/sqlts/PORTABILITY.md`. Check with the project's `tsc --noEmit --runExternalCode -p tsconfig.json` (the flag is command-line only); `sqlts check -p tsconfig.json` is an equivalent shortcut. Preserve existing project settings and credentials.

## 2. Mapper-enabled TypeScript project

Write queries in `.sqlts`, importing `{ sql }` directly from `@sqlts/core`. Ordinary `.ts` callers import those query files. A minimal isolated tsconfig for adjacent `queries.sqlts` and `consumer.ts` is:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "preserve",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noUncheckedIndexedAccess": true
  },
  "contentMappers": [{ "package": "@sqlts/core", "extensions": [".sqlts"] }],
  "files": ["queries.sqlts", "consumer.ts"]
}
```

Adapt `files` or `include` to the real source layout. Merge into an appropriate existing config or create an isolated config when the project mixes workflows. Do not replace the application's tsconfig blindly.

## 3. Database, check command, and execution

Use the project's development `DATABASE_URL` or existing Reylo connection configuration. SQL analysis needs database access both during checking and during module loading. Reuse configured credentials without displaying them. Do not run migrations or seed scripts as an implicit setup step; absent credentials or schema require the corresponding project setup, not suppressed SQL errors.

From the checkout root, the existing user-search example is checked with:

```sh
node --env-file=.env node_modules/typescript/bin/tsc --noEmit --runExternalCode -p experiments/user-search/tsconfig.json
```

For a new project, make its check script select its actual tsconfig. `--runExternalCode` enables execution of the configured mapper; use the project's known local mapper. `.env` is an example of the existing checkout's environment loading, not a requirement to create or copy secrets into new directories. Root `bun check` now includes `sqlts:check:all`, which discovers mapper-enabled tsconfigs directly under `experiments/`. `sqlts:check` still targets the original SQLTS demo. A separate project needs its own check script selecting its real files.

Node execution uses `--import @sqlts/core/register`; Bun uses `--preload @sqlts/core/register`. The existing `sqlts:demo` and `sqlts:demo:bun` scripts show full commands. Adapt the entrypoint and environment loading to the application. `.run(db)` executes the query; no explicit `.compile()` or generation command is required.

## 4. Zed, when used

Check settings for the folder actually opened in Zed. Settings inside `experiments/sqlts/.zed` do not configure sibling directories opened from the repository root. The essential settings for the current `typescript-ls` integration are:

```json
{
  "file_types": { "TypeScript": ["sqlts"] },
  "lsp": {
    "typescript-ls": {
      "binary": {
        "path": "node_modules/typescript/bin/tsc",
        "arguments": ["--lsp", "--stdio"]
      },
      "initialization_options": { "runExternalCode": true }
    }
  }
}
```

Merge these fields, preserving other associations and servers. Resolve the compiler path relative to the opened project; a separately opened subdirectory may need the checkout's absolute compiler path. Ensure TypeScript's active language server is `typescript-ls` using that binary, rather than another server that ignores these settings. Reuse the checkout's existing server registration/selection; this snippet alone does not install a Zed extension. Use `initialization_options.runExternalCode` for LSP startup, not the checker's CLI flag in the server arguments. Keep this project-scoped.

After changing initialization settings or upgrading the mapper, restart the language server or reopen the project once. Saved shared-helper edits then refresh automatically through native registered file watches; no consumer edit or routine restart is needed. Unsaved helpers retain the fingerprint diagnostic until saved. Verify that the consumer resolves its `.sqlts` import and hovering an inferred result field shows the expected type instead of `any`. A passing CLI check plus TS2307 in Zed is a reason to inspect the active server, opened project, and mapper initialization. If the editor reports a database connection error, verify its connection environment separately from the shell's environment.

SQL coloring and table/column/function completion come from `reylo-inline-preview`, running with Bun (`scripts/preview-server.ts` in the checkout, a packaged JavaScript binary in the tarball). The repository extension launches it automatically; the separately opened SQLTS demo uses a local binary override and passes the checkout root with `--project` so its catalog worker finds the development database configuration. Preserve this server alongside native TypeScript. The standalone Node `src/sqlts/color-server.ts` supports coloring only and will not supply table suggestions.

Use Control-Space / `editor: show completions` after `FROM schema.` or an alias such as `u.`. The catalog is cached for 60 seconds and refreshed on save or `reylo.inline.refreshSchema`. Verify suggestions against unsaved SQL, including nested `sql.fragment` predicates. The preview server leaves SQLTS validation and inferred caller types to native TypeScript; these are separate from catalog suggestions.

## Verify and report

Use a small query against an existing development table and an ordinary TypeScript caller. Check those exact files with the mapper-enabled compiler. When editor setup is part of the task, also verify cross-file types in the editor or its language-server protocol; if only CLI checks ran, say so. For runtime setup, verify the loader with a permitted read-only query. Report which of checking, execution, and editor behavior were actually tested, plus any remaining local-path dependency. Do not claim a full setup from a successful check of an unrelated demo.

## Optional production deployment

The no-generation development loader analyzes at module load. For production, first typecheck,
then run `bun node_modules/@sqlts/core/src/sqlts/cli.js build app.ts dist/app.mjs`.
The checkout equivalent is `bun run sqlts:build app.ts dist/app.mjs`. The bundler needs Bun
and the development database, but the emitted module runs on Node/Bun with only the
application's runtime dependencies (including `reylo@0.6` and its driver). SQLTS, the
compiler and the SQL analyzer are not required there. Query execution still needs the
production database; Reylo's periodic schema checks remain active.

This build is optional, not part of the no-generation development promise. It does not
replace typechecking. Source-mapped runtime stacks and Cloudflare adapters remain unsupported.
The package does not automatically install the Zed extension; distinguish portable CLI/LSP
tests from a graphical editor setup test.

The package's `reylo-inline-preview` command is a Node launcher for Bun. Use
that command (or `node node_modules/@sqlts/core/src/sqlts/preview-cli.js`)
with `--project /absolute/path/to/application`; it supplies the packaged isolated Bun
configuration and workers. Do not launch its internal preview-server.js directly:
that can inherit application preload hooks. The existing checkout extension already
passes its isolated configuration. See PORTABILITY.md for Zed binary override examples.

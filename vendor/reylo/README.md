# Pinned Reylo source build

Upstream: https://github.com/colinhacks/reylo/tree/c8a03f97b870ddea6bb973485bacf4737c82f502

The runtime and PostgreSQL engine are built from this exact revision. `revision.json` records the package SHA-256 values and the engine artifact hash. The upstream engine is committed WASM; upstream fingerprint tests passed against its source. The private version `0.5.0-sqlts.c8a03f9` and `sqltsSourceCommit` manifest field distinguish these packages from the published 0.5.0 release. SQLTS rejects a mismatched pair.

## Installation

Run `bun install` in this checkout. For another project run `bun run sqlts:pack`, then install all three paths printed by it together:

```sh
bun add /path/reylo-sqlts-experiment-0.0.3.tgz /path/reylo-0.5.0-sqlts.c8a03f9.tgz /path/reylosql-postgres-0.5.0-sqlts.c8a03f9.tgz pg
bun add -d typescript@7.1.0-beta @types/node @types/pg
```

A runtime-only application bundle needs the matching Reylo runtime and its database driver. The engine and SQLTS checker are development/build dependencies for that deployment.

## Rebuilding

Fetch the commit above, read its AGENTS.md, and install the root, packages/postgres, packages/mysql, and site dependencies. Run `node --test tests/fingerprint.test.ts`, then the upstream `scripts/build.ts`. The local build used Bun instead of the unavailable nub launcher for the script's single `build:play` invocation; no analyzer/runtime sources changed. Use the upstream lockfiles. Copy the upstream LICENSE into both package directories. Change the generated runtime and PostgreSQL manifests to the private version, add `sqltsSourceCommit`, and change the runtime's engine peer versions to match before `npm pack --ignore-scripts`.

Never update the runtime, toolchain bundle, or browser WASM independently. Rebuild packages, record their hashes, update both lockfiles, and run the native and browser integration suites. Decoder changes in this revision include vectors as number arrays, hstore as objects, and intervals in the upstream duration format.

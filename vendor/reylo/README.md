# Code copied from Reylo

Reylo (https://github.com/colinhacks/reylo) is MIT-licensed; its license is in `LICENSE` here.

SQLTS depends on the public `reylo` and `@reylosql/postgres` packages from npm (0.6.x). A few files
in this repository are copied from Reylo source at commit
[c8a03f9](https://github.com/colinhacks/reylo/tree/c8a03f97b870ddea6bb973485bacf4737c82f502) and
keep that license:

- `src/postgres-codes.ts`
- the lexical helpers used by `src/adapter/reylo.ts`

## Upgrading Reylo

`src/adapter/reylo.ts` uses Reylo internals (the `@reylosql/postgres/tooling` entry, `values.js`,
and the layout of generated declarations), so it accepts one minor version at a time. Before
widening it:

1. Diff the new `reylo` and `@reylosql/postgres` packages against the current ones (runtime files,
   `tooling`, `values.js`) and read the upstream changes to the PostgreSQL engine.
2. Update the version check in `src/adapter/reylo.ts`, the dependencies in `package.json`, and the
   peer ranges in `scripts/pack-sqlts.ts`.
3. Run `bun run check`, including the packaging test, which installs the packed SQLTS tarball in a
   fresh project.

Upgrading from the private 0.5.0-sqlts.c8a03f9 build to 0.6.0 changed no runtime or tooling files;
only `engine.wasm` differs (upstream #126: views now carry their tables' keys for the row-count
proof).

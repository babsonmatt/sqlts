# Automatic query identity prototype

This is a separate experiment. You write `sql.auto` without a query name:

```ts
import { sql } from "./sql.ts";
export function users(orgId: number) {
  return sql.auto`
    SELECT id, name, email
    FROM reylo_inline_demo.users
    WHERE org_id = ${orgId}
  `;
}
```

The generated mirror replaces each `.auto` tag with a hidden `.query("auto_...")`.
The existing Reylo generator analyzes it against PostgreSQL and produces the exact
parameter/result types and runtime metadata. Bun checks and executes the mirror.
No source template is evaluated during generation. Application execution happens
only in the run command or when executing a built bundle.

## Try it

From the **repository root**:

```sh
bun run auto:check
bun run auto:demo
bun run auto:build
bun experiments/auto/.auto/dist/demo.js
```

Uses the existing root `.env`, Reylo configuration and `reylo_inline_demo` fixture.
`auto:demo` runs read-only SELECTs. `auto:build` produces a standalone runtime bundle;
the generator and editor are absent from that bundle. These commands regenerate
before checking/building; a generation/check failure does not publish a new snapshot.
The snapshot is self-contained for the demo, including its typed generated facade.

This is **not native Bun support for `.auto`**. Directly running/checking an original
experiment `.ts` file is unsupported and intentionally fails instead of pretending
its result is `any`. Run the wrapper commands above. Root `bun check` checks the
implementation and tests; `auto:check` checks the experiment sources through the
transform. Source files here are excluded from the root linter for this reason.

## Zed tour

Open this `experiments/auto` folder **as its own project**. Its `.zed/settings.json`
uses the existing installed TypeScript language registration with an experimental
server binary; the parent project's editor settings stay unchanged. The local
settings currently name this checkout's absolute path; adjust them on another Mac.

- `queries.ts`: hover `.auto` for full SQL and symbolic bindings; SQL is colored.
- `consumer.ts`: hover `userId`, `userName`, `email`. Results flow through imports
  as `number | undefined`, `string | undefined`, `string | null | undefined`.
- Complete `names[0]?.` to see `name` and `email`, without the other query's `id`.
- Change a SQL column to `id2`: the original SQL token receives a database error.
- Change selected `name` to `id`: the caller's `.name` access becomes a TypeScript
  error, even before saving. Undo the edit to restore the example.
- `contracts.ts` contains checked assertions and expected negative parameter/result
  cases. Removing an `@ts-expect-error` makes `auto:check` fail.

The server runs a real TypeScript 5.9 language service over generated source, maps
locations to the original files, and combines it with SQL previews/completions and
colors. These are inferred types, not fabricated hover text. Bun's CLI checker is
still the authoritative build check (its compiler version differs from the prototype
editor). SQL errors remove the previous inferred-type state; SQL previews, coloring
and catalog completions can continue independently while SQL is invalid.

Analysis starts after a 250 ms edit pause or on demand for a type request. One worker
runs at a time; new edits cancel superseded workers. Unsaved text participates in
whole-project generation without rewriting the authored files or publishing the
CLI snapshot. Workers time out after 20 seconds. Editor snapshots are deleted on
normal shutdown/cancellation; abnormal process termination can leave scratch files.

## Boundaries and next work

- This is a proof of the source integration, not a replacement for a complete TS
  editor. It implements hover, completion, definition, diagnostics and SQL coloring;
  rename, code actions, auto-import edits and full TypeScript LSP parity remain.
- Each changed revision rebuilds the small project and its language service. The
  implementation is bounded at 64 `.ts` source files, 500 KB per file, and the
  existing 64 SQL shapes per query. Incremental generation/checking, large-project
  benchmarks and schema-refresh integration remain follow-on work.
- Ordinary static relative imports/re-exports within the project keep their layout;
  static imports leaving it are redirected to their original targets. This is not
  a general bundler transform: TSX, path aliases, assets, computed imports,
  `import.meta.url`-relative resources and package publishing are not covered.
- Import `{ sql }` (optionally aliased) directly from this project's `sql.ts` marker.
  Re-exporting the marker, nested complete `.auto` queries and arbitrary fragment
  helper functions are unsupported. Existing inline fragment/conditional limits
  still apply. Fragment tags continue to be plain `sql` in this experiment.
- IDs include the relative file, template source and occurrence among identical
  sites. Unrelated line changes preserve them; SQL edits/file moves may change them.
- Successful CLI snapshots are retained under `.auto/snapshots`; `.auto/current.json`
  points at the most recently published one. They are disposable build artifacts.
  Running an old snapshot directly runs that old source. Use the wrappers to rebuild.
- The database is needed at development/check time. Existing Reylo runtime schema
  checks still apply. No SQL analyzer or TypeScript service is added to query execution.

Plain `sql` templates can use this same identity transform in a separate opt-in API,
with `sql.fragment` for fragments. That syntax change has **not** been made: current
named queries and their plain `sql` fragment tags retain their existing semantics.

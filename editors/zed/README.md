# Reylo Inline SQL Preview

This is independent of the existing Reylo SQL composition extension.

## Install

Open the `reylo-inline-sql` project root in Zed. Run `zed: install dev extension`
and select this `editors/zed` directory. Zed builds the pinned Rust extension with
its normal development-extension flow. Bun must be on the project's shell PATH.
The project settings already enable this preview server alongside TypeScript 7.

## Try

1. Open `examples/queries.ts` and hover `query` in `sql.query("searchUsers")`.
2. The live preview says **Live source preview**; it shows full SQL alternatives,
   truthy/falsy conditions and `$n` binding expressions.
3. A separate TypeScript hover section says **Generated preview** and reflects the
   last successful type generation. Scroll the popup to see further alternatives.
4. Open `examples/ide-demo.ts`; hover `userId`, `email`, `position`, and the row values.
5. Change a selected column to `id2`: an error underline appears even before saving.
   Correct it to `id` and the error clears. Hover the underline for the database error.
6. Run `bun run dev:types` in a terminal for inferred types to refresh on saved SQL edits.

The hover server launches with `--no-env-file` and an empty Bun config. Hover rendering
uses only open editor text. SQL diagnostics run separately in an isolated worker that
loads the project's environment / `.env` and contacts the development database through
Reylo. No application code runs, and generated types are not overwritten.
Diagnostics debounce edits by 250 ms, validate all supported source alternatives,
map errors back to TypeScript, and discard stale results. One worker runs at a time
with a 15 second timeout and a 256-distinct-shape budget per document. Save to recheck
schema changes (subject to Reylo's own schema refresh interval).
The server does not infer the actual runtime branch.
SQL template coloring is provided by LSP semantic tokens. Enable
`"semantic_tokens": "combined"` under the TypeScript and TSX language settings
(already enabled in this project). SQL tokens are mapped to authored source;
JavaScript interpolations retain TypeScript highlighting. Restart the language
server after changing settings. Coloring and suggestions tolerate incomplete edits;
Reylo validation and generation remain strict.

The extension first resolves an installed
`node_modules/reylo-inline-sql-experiment/scripts/preview-server.ts`, then falls back
to `scripts/preview-server.ts` in a source checkout. It passes the consumer project
root to the server; workers load that project's `.env` / Reylo configuration.
No absolute developer-machine path is embedded in the extension.

For another project, install the experiment as a local directory dependency (it is
not published), install this dev extension, and explicitly enable
`reylo-inline-preview` alongside your TypeScript server. The extension is opt-in on
Zed versions supporting `opt_in_languages`. On older versions, disable it explicitly
in unrelated projects. The consumer still needs generated `.inline/sql.ts` and its
normal SQL/type-generation setup; installing the editor alone does not generate types.

You can also start the LSP directly:

```sh
bun --no-env-file --config=/path/to/package/editors/zed/server.bunfig.toml \
  /path/to/package/scripts/preview-server.ts --project /path/to/consumer
```

The LSP command `reylo.inline.refreshSchema` refreshes catalog and editor diagnostics.
Saving an inline file also refreshes the catalog. Applied schema changes still need
`bun run typecheck` to regenerate TypeScript types. Requests cancelled or superseded
by edits are discarded.
Reference: https://zed.dev/docs/extensions/developing-extensions

After changing server source, run `editor: restart language server` in Zed.

## Complete SQL

Type `u.` in `SELECT u.id ... FROM reylo_inline_demo.users u` to open column
suggestions, or invoke `editor: show completions` / Ctrl-Space. Navigate with arrows
and accept with Tab. `FROM reylo_inline_demo.` offers relations in that schema.
Column details show catalog types and table nullability. The catalog is cached for
60 seconds, refreshed on save, and read in a separate worker using the development
database configuration. CTE/subquery output columns, correlated/LATERAL references,
INSERT/UPDATE/DELETE/MERGE targets, RETURNING and EXCLUDED are supported too.
Known polymorphic array/range/composite outputs and explicit anonymous-record column
definitions are included; ambiguous types remain labeled `SQL expression`.

Open `examples/completion/queries.ts` for the typed playground. Hover `lower` or another
function name to see cached PostgreSQL overloads. Function names and declared function
output columns are also completed. LSP signature help tracks the active argument;
Zed may show TypeScript's outer template-tag signature instead, so SQL signatures
remain available in function hover and completion details.

Projection names are inferred locally. Unresolved expression types and projected
nullability are labeled rather than treated as database-validated types. See the
main README for the bounded parser's remaining scope limitations.

## SQLTS queries

The same server now supports `.sqlts` queries importing `reylo-sqlts-experiment`:
SQL table/column/function completion, scope-aware suggestions in nested fragments,
and semantic coloring. Native TypeScript 7 with the configured content mapper handles
inferred types, query hovers, and SQL diagnostics. The preview server skips its named-query
diagnostic worker for `.sqlts` documents. Enable the mapper with the project's
`initialization_options.runExternalCode: true` and associate `sqlts` with TypeScript.
See `experiments/sqlts/README.md` for the complete no-generation workflow.

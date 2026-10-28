# Inline IDE milestone

- [x] Guided inferred-type demo (numbers, nullable strings, bigint, rejected input/result access).
- [x] Generated SQL documentation on query-specific TypeScript overloads.
- [x] Live source SQL previews with branch conditions and symbolic bindings.
- [x] Preserve distinct bindings when different source branches produce identical SQL.
- [x] Separate Zed extension and project-local language server settings.
- [x] Debounced, serialized type-generation watcher with last-good output retention.
- [x] Terminal inspection of all source alternatives.
- [x] Unit, database, TypeScript LSP, preview LSP, watcher and bundle checks.
- [x] Preview latency benchmark and bounded document/path/output sizes.

- [x] SQL diagnostics on unsaved TypeScript, mapped to source tokens.
- [x] Cached table/schema/column/function completion and function signature help.
- [x] CTE/subquery projection names, correlated/LATERAL scopes and write-statement contexts.
- [x] Typed completion playground and database-backed LSP regression coverage.

- [x] Tolerant completion during incomplete SQL/TypeScript edits.
- [x] Complex scope regressions, UNION ordering and JOIN forward-reference boundaries.
- [x] MERGE branches; conservative polymorphic and anonymous-record outputs.
- [x] Cached SQL semantic-token coloring, visually verified in Zed.
- [x] Request cancellation, edit-version checks and in-flight catalog invalidation.
- [x] Real schema-change regression across completion, diagnostics and generation.
- [x] Large-schema/conditional-query completion benchmark.
- [x] Consumer-project server roots and installed-package extension resolution.

## Next separate milestones

These remain deliberate follow-on work, not claims of implemented support:

1. Source identities for reusable fragments and branches with different input types.
2. Support a bounded set of immutable fragment aliases/helper functions.
3. Explore condition-specific result narrowing without unsound inference.
4. Broaden PostgreSQL statement/parameter compatibility coverage.
5. Publish/distribute the generator and editor server as versioned packages.
6. Harden the separate automatic query identity prototype for wider projects.

## Nameless-query experiment

- [x] Probe native tagged-template inference and compiler content-mapper support.
- [x] Verify custom-extension and ordinary-string positive controls.
- [ ] Native nameless `.ts` queries: blocked by the installed compiler capabilities.

See `experiments/nameless/README.md`; the existing query API is unchanged.

## Generated-source auto prototype

- [x] Stable per-site hidden IDs, lexical binding resolution and UTF-16 source mapping.
- [x] Bun checking, execution and bundling through a generated project snapshot.
- [x] Cross-file result/parameter type checks and mapped invalid-SQL diagnostics.
- [x] Opt-in editor bridge with actual TypeScript language service types for unsaved edits.
- [x] SQL hover/coloring/completion plus caller completions and type errors.
- [x] Zed type hover and SQL preview/coloring visually verified in the isolated project.
- [ ] Portable packaging, incremental whole-project generation and full TypeScript LSP parity.
- [ ] Opt-in plain sql query API with explicit sql.fragment tags.

## No-generation custom-extension proof

- [x] `.sqlts` with plain query tags and explicit `sql.fragment`, no authored IDs.
- [x] Native TypeScript content mapper supplies types in memory, with source mappings.
- [x] Distinct query results and parameter/SQL/result-error negative checks.
- [x] Native TypeScript LSP cross-file types/completion and unsaved-edit recovery.
- [x] Zed source association, type hover and full SQL preview visually verified.
- [x] Direct Node and Bun execution using loaders and the same `pg` driver.
- [x] Verify no generated TypeScript/JavaScript modules or build directories are needed.
- [x] SQLTS semantic highlighting across interpolations and inside fragments, with no DB access or generated files.
- [ ] Port SQL catalog completion, improve tag-hover naming and runtime stack mappings.
- [ ] Package independently; benchmark startup and large projects; deployment integrations.

This proof lives in `experiments/sqlts`; it does not replace the named or `.auto` APIs.

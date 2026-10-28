---
name: using-reylo-inline
description: Set up, write, and debug typed PostgreSQL queries in the Reylo inline SQL prototype, especially .sqlts files importing reylo-sqlts-experiment or named inline queries importing .inline/sql.ts. Covers local setup, conditional fragments, inferred types, SQL-aware checks, and Zed mapper configuration. Use for this inline API, not ordinary Reylo .sql imports or the separate .compose.sql builder.
---

# Reylo inline SQL

Preserve the project's existing workflow. This skill describes a local prototype; read its package scripts and nearby working queries before assuming package names, commands, or support are unchanged. The database supplies schema information; do not introduce handwritten table schemas or row types to substitute for inference.

## Existing query or initial setup?

For a query edit in a working project, reuse its configuration and check that the relevant tsconfig includes the new files. Do not reinstall dependencies or rewrite editor settings on every query task.

For initial `.sqlts` setup, a new example directory, or missing-module/editor errors, read [local setup](references/setup.md). Inspect package resolution, compiler/mapper configuration, database access, checker coverage, and loader registration. Check editor configuration when the user uses that editor; repair missing project settings without replacing unrelated settings. CLI success alone does not prove editor support. The private `sqlts:pack` tarball supports separate projects; nothing is published. Do not invent a registry installation command.

## Identify the API

| Source                                       | Query and fragment syntax                                                                | Validation                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.sqlts`, importing `reylo-sqlts-experiment` | Outer `sql` is a complete query; nested `sql` or explicit `sql.fragment` supplies pieces | TypeScript content mapper; no separate generation step     |
| Ordinary `.ts`, importing `.inline/sql.ts`   | Complete `sql.query("uniqueName")` tagged template; pieces use `sql`                     | Regenerate that source's metadata, then typecheck          |
| `.auto` experiment                           | Preserve its existing transform-based API                                                | Use its own scripts; it still generates transformed source |

Do not migrate between these APIs merely to complete a query edit. For `.sqlts`, import `{ sql }` directly from its package; moving the query into ordinary `.ts` does not preserve mapper support. Ordinary `.ts` consumers can import `.sqlts` exports.

## Compose queries

Read [examples.md](references/examples.md) when writing conditional filters or maintaining a literal WHERE clause.

- Interpolated application values become parameters. Interpolating a string does not insert SQL syntax or an identifier. Do not concatenate user input into SQL text.
- In `.sqlts`, a `sql` template directly nested in another SQL template or used as an operand of `sql.where/and/or` is a fragment. Parentheses, ternary branches, and `&&` helper operands preserve this context. `sql.fragment` remains the explicit spelling; both forms may be mixed. A standalone `sql` template is still a complete query. Do not infer fragment context through arbitrary functions or callbacks.
- `sql.where(...)` emits a WHERE clause, joins present predicates with AND, and groups operands. Put all predicates for that clause inside it; placing it after a literal WHERE creates two WHERE clauses.
- `sql.and(...)` and `sql.or(...)` build grouped expressions. Place an optional OR search group alongside the required organization predicate so it cannot bypass that predicate.
- Helpers omit falsy operands. `condition && fragment` works inside these helpers; bare conditional fragment interpolation needs a ternary with `sql.empty`. Bound values inside fragments, including zero and false, remain parameters.
- Use presence checks such as `minId != null` when zero is meaningful. An empty search omits its filter only when that matches the requested behavior.
- Helpers do not reorder SQL clauses. The author still places WHERE, GROUP BY, HAVING, ORDER BY, and LIMIT correctly.
- SQLTS also supports shared const fragments and functions through direct relative `.sqlts` imports. Use explicit `sql.fragment` for standalone reusable pieces; functions use simple value parameters, const locals, and one final return. See `experiments/shared-queries` for examples. SQL is validated in each consumer alias/table context. Recursion, mutable fragment bindings, arrays/spreads, barrel re-exports and arbitrary callbacks/control flow remain unsupported. The older named API still requires direct fragments. Ordinary parameter expressions can be JavaScript expressions.
- Shared SQL comes from saved files. The native editor integration automatically refreshes consumers after helper saves, including external edits, when the editor forwards registered file watches. Unsaved shared-source edits still produce a fingerprint diagnostic; save the helper rather than suppressing it. Editors without watch forwarding need a manual recheck. Errors inside a shared piece map to its use in the consumer.

## Check the right source

Inspect `package.json` and the applicable tsconfig. In this checkout:

- `.sqlts`: `bun run sqlts:check` runs TypeScript with `--runExternalCode` and `experiments/sqlts/tsconfig.json`. For another fixture or project, select its actual mapper-enabled tsconfig with `-p`; checking the demo configuration alone does not check unrelated files.
- Named `.ts`: generation defaults to `examples/**/queries.ts`. For other files, pass explicit paths to `bun scripts/generate.ts`; include the intended source set rather than silently replacing the registry with a partial set. Then use `bun run typecheck:bun`.
- `bun run sqlts:check:all` checks mapper-enabled example directories with the native compiler. Root `bun check` now includes it alongside the named generation pipeline. Bun's built-in checker itself still cannot run content mappers. Oxc excludes these mapper projects; the native SQL-aware checks are authoritative.

Fresh SQL-aware checks read current saved helper dependencies, so agents do not need an editor refresh or generation step. Save edits and check the actual mapper-enabled project; only included/imported files are covered.

The `.sqlts` checker needs the configured development database. Use existing connection configuration without printing secrets. A connection failure is not a query/type failure. Do not run seed scripts or migrations merely to fix a query diagnostic.

Fix SQL errors at the authored query and TypeScript errors at their actual source. Do not hide them with `any`, assertions, handwritten result interfaces, suppressed diagnostics, or edits to generated output. In an explicit negative test, a deliberate failing fixture is appropriate; restore a passing fixture afterward and record both results.

## Execute and explain accurately

Call `.run(db)`; `.compile()` is optional SQL/bindings inspection. `.sqlts` Node execution needs the package's `/register` import; Bun needs its preload. Use existing run scripts as examples.

Checking analyzes possible SQL shapes without executing application conditions. SQLTS can specialize named functions, const arrows/function expressions, local query aliases and simple local forwarding wrappers for known primitive flags/literal choices and defaults, using the actual database-inferred branch types. Shared helpers carry proven argument bindings through their conditions and defaults. Runtime booleans, unknown captured state, unsupported guards, mutation and other function forms retain their possible-result union. New wrappers around imported queries or in ordinary `.ts` are not automatically specialized; a direct alias preserves its original signature. Do not infer nullability from a flag name or add handwritten overloads; verify the inferred caller type with the SQL-aware checker. The older named API still returns the full union. Shape enumeration is bounded; consult the local README when a limit is reached rather than bypassing validation.

No separate generation step does not mean no analysis: `.sqlts` analysis happens during checking and module loading, with a disposable Reylo cache. Request execution assembles parameters and uses cached executables; Reylo's normal schema-freshness checks still apply. After schema changes, rerun the SQL-aware checker and restart a stale language server if necessary. This prototype's Node/Bun loader is not a Cloudflare deployment integration.

SQLTS mutation coverage includes INSERT/UPDATE/DELETE/UPSERT, bulk array inputs, writable CTEs and RETURNING. Writes without RETURNING produce `never[]`. Use the supplied transaction client for related writes; examples do not authorize changing application data or schema. `sqlts:build` is an optional production bundle requiring Bun and development DB analysis at build time; its output runs without the SQLTS analyzer. Development remains no-generation. See [setup](references/setup.md) for installation and deployment details.

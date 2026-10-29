# Inline SQL without a generation/build step

This isolated experiment uses TypeScript 7.1's content mapper for `.sqlts` files.
Write complete queries as `sql` templates. Inside a query or the `sql.where`,
`sql.and`, and `sql.or` helpers, nested `sql` templates are fragments.
`sql.fragment` remains the explicit spelling and can be mixed with the shorthand:

```ts
import { sql } from "@sqlts/core";

export function findUsers(orgId: number, search?: string) {
  return sql`
    SELECT id, name, email FROM reylo_inline_demo.users
    ${sql.where(
      sql.fragment`org_id = ${orgId}`,
      search ? sql.fragment`name ILIKE ${`%${search}%`}` : undefined,
    )}
    ORDER BY id
  `;
}
```

The predicates above may also be written as `sql` templates:

```ts
sql.where(
  sql`org_id = ${orgId}`,
  search && sql.or(sql`name ILIKE ${`%${search}%`}`, sql.fragment`email ILIKE ${`%${search}%`}`),
);
```

Only complete outer queries receive query identities and `.run()` methods. Fragment
meaning comes from direct syntactic composition, including parentheses, ternary
branches and `&&` helper operands. Reusable pieces can also be exported with explicit `sql.fragment` from consts or
simple functions; see `../shared-queries/README.md`. Arbitrary callbacks/control flow
remain unsupported. A standalone `sql` template is still a complete
query; use `sql.fragment` to state fragment intent explicitly. Short-circuit omission
still requires a helper; use a ternary with `sql.empty` for direct query interpolation.
Both spellings produce the same analyzed SQL shapes, bindings and result types.
The `experiments/user-search` example uses the shorter spelling; the original
examples below keep the explicit form.

Import that `.sqlts` file directly from ordinary TypeScript and call `.run(db)`.
You do not assign a query name, run a generator, or maintain generated TypeScript.
The existing named API and `.auto` experiment are separate and retain their APIs.

## Optional predicates with `&&`

Ternaries still work. You can also write the same omission using JavaScript's
short-circuit operator inside `sql.where`, `sql.and`, or `sql.or`:

```ts
sql.where(
  sql.fragment`org_id = ${orgId}`,
  search && sql.fragment`name ILIKE ${`%${search}%`}`,
  onlyWithEmail && sql.fragment`email IS NOT NULL`,
);
```

These helpers skip falsy arguments (`undefined`, `null`, `false`, `""`, `0`, `0n`,
and `NaN` at runtime). They never discard bound values inside a fragment. If zero
is a valid filter value, use an explicit presence check:

```ts
sql.where(minAge != null && sql.fragment`age >= ${minAge}`);
```

`minAge && ...` would deliberately omit the predicate when zero. Truthy strings
and numbers are not accepted as SQL fragments. Arrays and object-style clsx
arguments are not added.

The analyzer checks both paths without executing conditions. Parameter typing,
SQL diagnostics, hover alternatives, highlighting and shape limits apply to the
new syntax too. Use a helper for omission: a bare `${condition && fragment}` in
a query is rejected because falsy template interpolations are bound values.

`searchUsersShorthand` in `queries.sqlts` demonstrates nested OR and optional email
filtering alongside the unchanged ternary example. The demo runs both forms.

## Run and check

From the repository root, after `bun install --frozen-lockfile` links the local
workspace package and the usual `DATABASE_URL` / fixture setup:

```sh
# Plain TypeScript checking with the mapper. No generation command precedes this.
node --env-file=.env node_modules/typescript/bin/tsc --noEmit --runExternalCode -p experiments/sqlts/tsconfig.json

# Direct Node execution: the loader handles .sqlts imports in memory.
node --env-file=.env --import @sqlts/core/register experiments/sqlts/demo.ts

# Direct Bun execution: the preload registers the .sqlts loader.
bun --preload @sqlts/core/register experiments/sqlts/demo.ts
```

The root scripts `sqlts:check`, `sqlts:demo`, and `sqlts:demo:bun` are shortcuts for
exactly those commands. No precheck, generator or build wrapper runs before the demo.
The read-only demo uses postgres.js on both runtimes, rather than depending on `Bun.SQL`.
Verified on Node 25.2.1, Bun 1.4.4-canary and TypeScript 7.1.0-beta.

The **Bun runtime works; Bun's built-in checker cannot check content mappers** on
this toolchain. Use the TypeScript command above for this project. Root `bun check` retains the original named experiment's generation workflow and now
also runs `sqlts:check:all` through the native compiler. `bun run sqlts:check:all` checks
the mapper-enabled example projects without invoking the named generator.

For a standalone installed project, you can configure `bun check` as a script shortcut
to this same SQL-aware compiler. See [the optional shortcut setup](PORTABILITY.md#optional-bun-check-shortcut).
It does not switch to Bun's built-in checker or change the runtime.

## What happens automatically

1. TypeScript requests an in-memory representation for each imported/included
   `.sqlts` file. The mapper parses its templates without executing the application.
2. Reylo validates the possible SQL shapes against PostgreSQL and infers the input
   and output types. Each query gets its own signature, including when two queries
   have identical parameter types and different result columns.
3. TypeScript checks that representation and maps diagnostics and editor operations
   to the authored file. Cross-file callers use the inferred exports normally.
4. At runtime the loader analyzes the imported module, creates query metadata and
   transpiles its TypeScript in memory. Node uses a worker for analysis; Bun uses
   its asynchronous loader. The runtime module then executes normally with the application's driver.

There are no emitted `.ts`, `.js`, `.d.ts`, `.inline`, `.auto`, or `dist` artifacts
for the experiment. Reylo's normal disposable `.reylo` analysis cache is allowed.
The runtime reuses one Reylo executable per query ID and analyzed SQL shape within
each loaded module. Each query keeps its own parameter snapshot and receives its
client at execution. This preserves Reylo's normal schema-freshness interval
without performing a new schema check merely because parameter values changed.

The loader analyzes on module load, not each `.run()` call. Ordinary module caching
applies; restart the process to load saved source changes.

This is **no separate generation/build step**, not zero analysis or zero startup
work. The development database and analyzer dependencies are required when checking
and when loading these modules. An optional production build moves analysis to build time and produces a runtime-only
bundle. See [installation and deployment](PORTABILITY.md). This Node/Bun workflow
is not a Cloudflare Workers deployment integration.

## Editor tour

Open the repository root or this `experiments/sqlts` directory as a separate Zed project. Both settings
associate `.sqlts` with TypeScript and launch the installed TypeScript 7.1 language
server with `initialization_options.runExternalCode: true`. This grants the locally
configured mapper permission to execute, just as the CLI flag does. It uses the
normal native language server, not the `.auto` bridge. The settings currently point
to this checkout's absolute compiler path; update that path on another machine.

- Open `queries.sqlts`, hover `sql`: inferred input/output signature and full SQL
  alternatives with symbolic bindings. The preview server colors
  SQL across `${...}` boundaries and inside `sql.fragment`, leaving interpolated
  JavaScript to TypeScript. Coloring tolerates incomplete edits and does not query
  the database, run a mapper, or generate files.
- Open `consumer.ts`, hover `userId`, `userName`, `email`: the inferred result types
  flow across imports, including nullable email and possible absent array elements.
- Complete `names[0]?.`: only `name` and `email` are offered.
- Change selected `name` to `id` without saving: caller result types/completions update.
- Change `id` to `id2`: the database error is mapped onto the actual SQL token.
- `contracts.ts` checks exact inferred types and includes one expected invalid access.

Types, SQL previews, cross-file completion and SQL diagnostics are covered by native
LSP protocol tests. Type hover and SQL preview were also verified visually in Zed.
SQL coloring and catalog completion use the SQLTS Zed extension (`editors/zed`)
and `scripts/preview-server.ts` (Bun in this checkout; Node or Bun from the package). The subdirectory settings point
that server at the checkout root for its development database configuration. The
native TypeScript server remains responsible for `.sqlts` diagnostics, inferred
caller types, and query-tag hovers; the preview server does not duplicate SQLTS
validation or generate files.

After restarting the language server, use Ctrl-Space / `editor: show completions`:

- `FROM reylo_inline_demo.` suggests tables; partial names such as `user` are replaced.
- `SELECT u.` or a `sql.fragment` predicate suggests columns for that alias.
- CTE/subquery outputs and SQL function completion reuse the existing scope engine.

Completion reads the database catalog in an isolated worker, caches it for 60 seconds,
and refreshes on save or `reylo.inline.refreshSchema`. SQL source mappings keep edits
in the authored template, including unsaved text and conditional fragments. JavaScript
expressions and SQL comments/string literals do not receive SQL completions. The
standalone Node `src/sqlts/color-server.ts` is still available for database-free
coloring only, but is no longer the configured demo server.
Mapper-generated helper names can appear in native query-tag hover signatures.

## Current boundaries

- PostgreSQL only; existing inline limits remain: directly nested fragments/helpers
  and ternaries/`&&` helper operands, conservative result unions for unproven conditions, compatible positional parameter types
  for branches with equal binding counts. Shared const fragments and simple functions are
  supported through direct relative `.sqlts` imports; arbitrary JavaScript composition is not.
- Up to 64 structural/binding variants per query, 32 queries and 256 total variants per file,
  500 KB per source file. Equivalent SQL/binding branches merge with combined provenance.
  Identical SQL across sites is analyzed once per transform; later transforms still validate
  schema freshness. Shared expansion is bounded to 64 files, depth 32, 2048 expansions and
  1 MB of replacements per source file. Combined per-file SQL source maps are limited
  to two million UTF-16 mapping positions before allocating those maps.
- Import `{ sql }` (optionally aliased) directly from `@sqlts/core` in a
  `.sqlts` file. Plain `.ts` use deliberately fails instead of returning `any`.
- The loader strips TypeScript; it does not replace type checking. Run the native
  checker to reject TypeScript errors, as you would for ordinary application code.
- Mapper/compiler integration is beta and the analyzer uses Reylo 0.6.x (public npm release)
  internals. The analysis parser is the existing TypeScript 5.9 AST dependency.
- Schema freshness follows Reylo. After a migration signal `refresh-schema --project .`
  and run a fresh SQL-aware check. The signal refreshes editor catalogs and unchanged-file
  types; arbitrary external DDL is not automatically observed. See `PORTABILITY.md`.
- Runtime exception stacks are not source-mapped through the in-memory transform
  yet; checker and language-server positions are mapped and tested.
- The workspace plugin delegates to `src/sqlts`; `sqlts:pack` creates the standalone
  `@sqlts/core` tarball that is published to npm. Node's loader times out after 30 s.
- Shared dependency SQL is read from saved files. Fingerprint checks reject stale
  consumer analysis after unsaved dependency edits; save and recheck/restart the language
  server to refresh it. Shared SQL errors map to the consumer call site.

The tests deliberately introduce invalid columns, parameters and result accesses,
verify exact source locations including Unicode, restore source and check recovery,
run both runtimes, and assert no generated query-source artifacts appear.

## Shared queries and mutation coverage

`bun run sqlts:shared:check` checks the new shared-fragment/mutation examples;
`bun run sqlts:shared` runs the read-only demo and prints mutation SQL without executing it.
See `../shared-queries/README.md`.

The SQLTS regression suite checks INSERT, optional UPDATE assignments, UPSERT,
array-based bulk INSERT (including empty arrays), writable CTEs, DELETE and RETURNING.
It verifies inferred fields, rejects invalid columns/values, and exercises Node/Bun
with a supplied transaction client, rollback and PostgreSQL constraint errors.
No new database schema or seed data is needed. Writes without RETURNING now have
`never[]` results and an empty-array output schema, matching the facade's runtime.
This coverage is not a claim that every possible PostgreSQL statement/type is proven.

## Call-site SQL hovers

Hover a direct call to a named function imported from a relative `.sqlts` file
(or a local `.sqlts` function). The preview server resolves primitive literal
arguments, immutable primitive consts, omitted/default parameters, template-string
values and supported Boolean/conditional expressions without executing application
code or connecting to the database. For example, `findUsers(orgId, 10, "alice", true)`
shows the selected SQL path, bindings `%alice%` and `10`, and a symbolic `orgId`.
The SQL remains parameterized; it is not an interpolated executable string.

Unknown guards show the remaining possible paths. Arbitrary calls, mutable bindings,
spread/destructured parameters and function bodies with runtime control flow are
not evaluated. Supported query functions contain const locals and one final return
(or an arrow expression). The preview itself does not alter types and is not a debugger or a replacement
for SQL-aware checking. The mapper separately specializes supported function returns
as described below.

The preview uses current open buffers, including shared fragment files, and falls
back to saved source. Hovering the function declaration/import alone still uses
the normal TypeScript information. It appears alongside the native type hover in
Zed; restart the language servers after updating the preview implementation.

## Call-specific result types

The mapper now connects supported function arguments to each branch's database-inferred
row type. The authored SQL and function API stay the same:

```ts
const required = await findUsers(orgId, 10, undefined, true).run(db);
const optional = await findUsers(orgId, 10).run(db);
const conditional = await findUsers(orgId, 10, undefined, runtimeBoolean).run(db);

required[0]?.email; // string | undefined
optional[0]?.email; // string | null | undefined
conditional[0]?.email; // string | null | undefined
```

`undefined` here accounts for an empty result array. Narrowing selects Reylo's actual
inferred row types; it does not assume a flag named `onlyWithEmail` removes nulls.
Literal string/number choices can also select different projected columns.

Supported functions are named declarations, const arrows and const function expressions
with simple parameters. Block bodies use const locals and a final return; the SQL
query may be returned through local const aliases. Simple forwarding wrappers in
the same `.sqlts` module preserve specialization, including fixed flags and defaults. They have no authored generic parameters,
return annotation, async/generator modifier, overloads, rest or destructured parameters.
The proven conditions cover primitive parameter truthiness, immutable primitive aliases,
`!`, `&&`, `||`, strict comparisons against literals, and null presence checks. Selector
parameters use primitive/literal type annotations or inferred primitive literal defaults.
Omitted arguments and explicit `undefined` apply the authored default. A runtime boolean
or broad string retains every possible outcome. `ReturnType<typeof function>` remains
conservative because it represents all callers.

Conditions in shared `.sqlts` helpers preserve lexical argument bindings through nested
helpers, defaults and primitive const aliases. Unknown captured state, mutation and
unproven conditions keep their possible result types. Other function forms also keep
the existing union. Imported function aliases retain their original signature, but
new wrappers around imported query functions or wrappers in ordinary `.ts` files are
not automatically specialized. Local wrapper propagation is bounded to 16 forwarding levels;
helper proofs are bounded to depth 24 and 2048 visits per condition.
Writes through loop targets (including destructured `for…of` and `for…in` targets)
also prevent unsafe specialization, even inside nested closures. A shadowed local
variable does not count as a write to the original parameter.

Generated specialized signatures live at module scope. Functions whose parameter
annotations reference function-local types, captured type parameters, or another
parameter through `typeof` retain the broader inferred result. Their original
parameter types still check normally; no local type name is moved out of scope.

Call previews preserve shared-helper scalar defaults and lexical bindings: omitted
arguments and explicit `undefined` use the default; `null`, `false`, `0`, and `""`
do not. Proven primitive expressions and template strings can supply preview values.
Unknown captured state and arbitrary function calls remain symbolic. Previewing never
executes application code, including default expressions.
Merged equivalent paths may lose narrowing precision. This is deliberately conservative;
a particular call’s argument values do not suppress SQL validation. Contradictory
combinations of linked immutable guards are discarded; an explicitly disabled literal
branch by itself still receives SQL diagnostics.

The mapper supplies a conditional signature in memory, used by the native checker and
TypeScript language server. It adds no request-time checks, queries, or generated source
files. SQLTS module-loading analysis still happens as before; optional production bundles
remove the analyzer from deployed code.

Open `experiments/user-search/narrowing.ts` and hover `requiredEmail`, `optionalEmail`, and
`conditionalEmail`. Run it from the repository root with:

```sh
bun --preload @sqlts/core/register experiments/user-search/narrowing.ts
bun run sqlts:check:all
```

## Reusable narrowing and development performance

`experiments/shared-queries/reuse-demo.ts` demonstrates an imported predicate,
arrow query, local forwarding wrappers, preset flag and conditional projection.
Hover the calls for selected SQL and the result variables for inferred types.

```sh
bun run sqlts:reuse
bun run sqlts:check:all
bun run bench:sqlts:types
```

The benchmark creates 128 sites with 1,024 branch slots, measures warm transforms
with and without specialization, fresh SQL-aware checker processes using cached SQL,
and native LSP startup/warm hovers/argument edits. It checks each edited hover's
answer before recording latency. Its full samples and methodology are saved under
`work/sqlts-types-bench-*/results.json`. These are synthetic local development
measurements, not production request latency or guarantees for every schema.

Saved shared-helper changes automatically refresh consumer types and SQL diagnostics
in the native language server when the editor forwards its registered file watches.
This includes nested helpers, unopened query files, external edits and atomic saves.
The mapper watches the project's local import graph and uses a debounced temporary
watch signal to handle the compiler's open-buffer/save edge case. That signal contains
only a counter; no source file is rewritten. A dependency identity change invalidates
mapped transforms at project granularity, rather than only one consumer.

Unsaved shared-helper changes still raise a fingerprint diagnostic: save the helper
to analyze its new SQL. Query-local defaults and caller arguments retain their normal
unsaved-edit updates. Restart an already-running language server once after upgrading
the mapper; ordinary helper saves no longer require restarting it. Editors without
file-watch forwarding retain the fingerprint safeguard and need an explicit recheck.

For agents and CI, a fresh SQL-aware check reads saved dependencies directly and fails
on invalid shared SQL or incompatible inferred types. No editor, restart, generation,
or watcher event is required. Use `bun run sqlts:check:all` for this checkout's configured
examples, or `tsc --noEmit --runExternalCode -p tsconfig.json` in a project with `@sqlts/core` installed
(`sqlts check -p tsconfig.json` is the same check as a shortcut). Bun's built-in
checker alone does not execute content mappers; the SQL-aware scripts invoke the
mapper-enabled TypeScript compiler through Node. Checks cover their configured project,
not every arbitrary file elsewhere in the repository.

## Correctness matrix and project benchmarks

`bun test tests/sqlts-correctness-matrix.test.ts` compares inferred caller types and
SQL hover predictions with PostgreSQL results on Node and Bun. It covers primitive
truthiness, null presence, strict comparisons, defaults, aliases, combined guards,
shared helpers, forwarding wrappers, projection choices and parameter mutations.
Object-destructuring writes (including nested shorthand targets) disable unsafe narrowing.
An unannotated parameter defaulted from another parameter can still retain broader results.

`bun run bench:sqlts:project` measures 24 sites using 12 SQL forms, four forwarding
levels and two independent helper groups. It includes direct SQL edits and saved-helper
refresh latency, and verifies the expected hover before recording completion.
`bun run bench:completion` separately exercises synthetic catalogs containing 1,000
tables / 50,000 columns and 10,000 functions; these are completion data fixtures, not
a claim that SQL inference was measured against a database of that size.

The mapper caches parsed/expanded query preparation in memory, bounded to 128 files,
two million source characters including helpers, and a 16 MB estimated retention
weight that accounts for expanded SQL and source-map entries. The weight is an eviction
heuristic, not a measured or guaranteed JavaScript heap cap. Large individual entries
can bypass the cache. Per-file SQL source maps are capped at two million mapped
characters before allocating the combined maps. A cache hit rechecks saved
dependency fingerprints. Unchanged consumers can reuse preparation after a project
refresh; changed queries/helpers are expanded again. SQL/schema validation still runs
on every analysis call, and no inferred database types are cached by this layer.
Native compiler invalidation remains project-wide. No request-path work is added.

## Conditional and shared-graph stress coverage

`bun test tests/sqlts-conditional-stress.test.ts tests/sqlts-linked-shapes.test.ts tests/sqlts-graph-scale.test.ts`
checks 250 conditional calls against inferred types, Node/Bun execution and resolvable
call previews; linked join/projection guards; and 48 consumers sharing four diamond
helper graphs. It also checks atomic edits with unchanged file size/mtime, deletion/
restoration through existing cache regressions, recursive/over-wide graphs, cache
weight eviction and aggregate source-map limits.

Provable nullish expressions (`flag ?? fallback`), strict comparisons to the unshadowed
`undefined`, and typed defaults referencing earlier parameters now specialize across
supported direct/shared/wrapper paths. For example, `b: boolean = a` retains a known
`a` when `b` is omitted. Unknown defaults, unannotated dependent defaults, mutation,
and unsupported value expressions remain conservative. `NaN` is not treated as zero.

When the same immutable flag controls a join and a selected column, the analyzer can
remove contradictory on/off combinations before querying PostgreSQL. It recognizes
binding identity and negation, including supported shared proofs; it does not equate
different variables merely because both helpers call them `flag`. Mutated parameters,
mutable captures, property reads and unproven guards retain their combinations. This
is deliberately not a general JavaScript satisfiability engine. Existing 64-shape
expansion limits apply before this pruning; many repeated guards may still hit them.

`bun run bench:sqlts:stress` measures 96 query sites across the 48-consumer graph,
alternating cached/uncached preparation and then editing one shared leaf. It reports
hits, misses, schema validations and estimated cache weight. It analyzes read-only SQL
against the existing demo schema; it is not a large-database or runtime throughput test.

`tests/sqlts-boundary-types.test.ts` also checks every combination of six independent
projection flags: 64 SQL shapes, 384 positive column-type assertions, and 64 negative
assertions against the opposite type. Node and Bun execute all 64 shapes and compare
results with the same SQL through pg. A seventh independent flag is rejected at the
existing 64-shape limit instead of silently losing analysis coverage.

## PostgreSQL execution and metadata

Existing `query.run(db)` returns `Row[]`. The additional methods are opt-in:

```ts
const query = userById(1);
const rows = await query.run(db); // Row[]
const user = await query.execute(db); // Row | null for a unique-key lookup
const required = await query.one(db); // throws unless exactly one row
const optional = await query.maybeOne(db); // throws on multiple rows
const runOnTransaction = query.with(tx);
await runOnTransaction();
```

`execute` follows the inferred cardinality: `many`, `one`, `maybeOne`, or `none`.
Conditional signatures keep the union of possible cardinalities. `.one()` and
`.maybeOne()` enforce counts after execution and never add LIMIT or truncate rows.
A cardinality failure does not undo a write; use transactions for atomic operations.

`inputSchema` describes positional bindings (`p0`, `p1`, ...), not function argument
names or an HTTP request. `outputSchema` describes the JSON representation of the
array from `.run()`. Getters return independent copies. The query also exposes
Standard JSON Schema via `query["~standard"].jsonSchema.input/output()`. This is not
a Standard Schema runtime validator. Bigint and binary JSON serialization needs an
explicit application contract; the schema does not convert raw results.

`.compile()` and `.sql` preserve the engine's SQL rewrites and source annotation;
`.compile().values` contains original values before driver encoding/checks. The
schema-annotated `${payload}::jsonb('...schema...')` extension now works end to end:
the engine removes the schema from the executed cast while retaining runtime checks.
`.raw` is the selected named-parameter SQL, and `.source` identifies the module.
Analyzer-supported utility queries such as `EXPLAIN` can also be executed. This is
not a migration runner or COPY streaming interface: these execution features are not yet provided. Use dbmate for migrations and the native driver for streaming.

```ts
const result = await query.try(db);
if (result.error?.condition === "unique_violation") {
  result.error.code; // "23505"
  result.error.constraint; // Relevant constraint names | undefined when inferred
}
```

`.try()` returns arrays on success and PostgreSQL server errors as values.
Other failures still throw. The original error is `.cause`. Error conditions and
codes use PostgreSQL 18's definitions. Constraint/table/column names narrow where the analyzer can rule out user code. Triggers, functions, and some extension casts keep errors open; custom SQLSTATEs are returned with an undefined condition. PostgreSQL errors still abort a
transaction; a caught error is not a rollback or savepoint.

`subscribeQueries` from `@sqlts/core/runtime` provides opt-in start/end/error
events, with source, SQL, ID, duration and row count, excluding bindings and row values.
Observer exceptions do not change execution. `enableQueryTracing` from
`@sqlts/core/tracing` forwards those events to Node/Bun's `sqlts:query`
diagnostics channel; call its returned function to disable it. No timing is collected
without subscribers.

### Native affected-row counts

`query.runWithMetadata(db)` returns `{ rows, affectedRows, command }`. Rows keep
the inferred result type and Reylo decoding; `affectedRows: number | null` is the
native top-level write count (null if unavailable), and `command: string | null`
is the native command tag. This uses the same execution, without an extra count
query or added RETURNING. `.run()`, `.execute()`, and `.try()` retain their contracts.

Writes without RETURNING have empty `never[]` rows but can report a nonzero count.
Zero means no rows written. Counts do not sum trigger/CTE side effects; a top-level
SELECT reports zero writes. PostgreSQL UPDATE counts matched rows, even if values
are unchanged. PGlite 0.4.6 reports affectedRows without a command tag. Missing or
unsafe-integer metadata stays null; never infer it from rows.length.

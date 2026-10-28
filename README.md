# Inline SQL experiment

A separate experiment beside `bun reylo sql`. It has its own dependencies, lockfile,
runtime, generator, tests, and database fixture. It does not import or preload the
existing composition package. The only copied implementation is a version-pinned
Reylo adapter and its lexical helpers, under `src/adapter`.

## Try it

```sh
git clone https://github.com/babsonmatt/sqlts.git
cd sqlts
# Requires Bun 1.4.4 or newer.
bun install --frozen-lockfile
# Set DATABASE_URL in .env when setting up another machine.
bun run db:seed
bun run generate
bun examples/demo.ts
```

The seed only creates/updates the dedicated `reylo_inline_demo` schema. It uses the
same local PostgreSQL server as the other experiment; its tables are separate.

Start with **examples/queries.ts**. **examples/demo.ts** prints compiled SQL,
bindings, and results. Calling `compile()` is optional; `run(db)` handles execution.
Open **examples/ide-demo.ts** for a guided type-hover tour: inferred numbers,
nullable email, bigint window results, and commented examples of rejected inputs.
Hover **query** in `sql.query("searchUsers")` in **examples/queries.ts** for generated
SQL documentation in the normal TypeScript language server.

A separate **Reylo Inline SQL Preview (Local)** Zed extension under `editors/zed`
adds live source previews, including unsaved edits. It runs alongside TypeScript,
uses the project's own server, and does not change the existing SQL-file extension.
See `editors/zed/README.md` for installation and use. Inline SQL highlighting is supplied by semantic tokens, described below.

```ts
import { sql } from "../.inline/sql.ts";

function findUsers(orgId: number, search: string | undefined, onlyWithEmail: boolean) {
  return sql.query("findUsers")`
    SELECT u.id, u.name, u.email
    FROM reylo_inline_demo.users u
    ${sql.where(
      sql`u.org_id = ${orgId}`,
      search
        ? sql.or(sql`u.name ILIKE ${`%${search}%`}`, sql`u.email ILIKE ${`%${search}%`}`)
        : undefined,
      onlyWithEmail ? sql`u.email IS NOT NULL` : undefined,
    )}
    ORDER BY u.id
  `;
}
```

Add new queries to `examples/queries.ts`, or pass explicit source files to
`bun scripts/generate.ts file1.ts file2.ts`. The generator scans the default
`examples/**/queries.ts` paths. Every site needs a unique ID. Generated query IDs
become available after generation; the README example is illustrative until added
to an analyzed source file.

## Conditional composition

`sql.where(...)` removes absent predicates, parenthesizes each remaining expression,
and joins them with AND. If none remain, it emits no WHERE. Supply every predicate
for that clause to this helper; placing it after an existing WHERE would create a
second WHERE and generation rejects that SQL.

`sql.and(...)` and `sql.or(...)` produce parenthesized expressions. Empty AND is TRUE;
empty OR is FALSE. Missing operands may be `undefined`, `null`, `false`, `""`, `0`, `0n`, or `sql.empty`.
The helpers also skip `NaN` at runtime. They accept conditional fragments using
`&&` as an alternative to ternaries:

```ts
sql.where(search && sql`name ILIKE ${search}`);
```

Falsy values inside fragment interpolations remain normal bound parameters.
Use explicit presence checks when zero or an empty string is a meaningful value:

```ts
sql.where(minAge != null && sql`age >= ${minAge}`);
```

Short-circuit fragments must be inside `sql.where`, `sql.and`, or `sql.or`;
ordinary `${a && b}` value interpolations remain parameters.
Helpers do not move clauses: WHERE still goes before GROUP BY/ORDER BY/LIMIT.

For direct syntax, the `rawSearchUsers` example has a permanent `WHERE org_id = ...`
and ternaries selecting `sql` templates that begin with `AND`, or `sql.empty`. This
also works, but the author owns conjunctions. Arbitrary interpolated strings are
always bound values, never SQL structure.

## When typing happens

1. `bun run generate` parses TypeScript without importing or executing the app.
2. It enumerates direct nested SQL tags/helpers and ternary fragment branches and `&&` helper operands.
3. The pinned Reylo analyzer validates each SQL shape against the development
   database and infers parameters, output columns, nullability, and decoding metadata.
4. It atomically writes `.inline/sql.ts`, a typed facade and executable metadata.
5. `bun run typecheck` regenerates, then runs Bun's built-in TypeScript checker. It rejects
   invalid interpolation types, unknown query IDs, and invalid result accesses.
6. Runtime assembly chooses an exactly matching analyzed shape, binds values, and
   calls Reylo's runtime with the supplied database client. No TypeScript parser or
   SQL analysis engine ships in the application bundle. Reylo's normal runtime
   schema freshness checks and value conversion still apply.

TypeScript does not pass the SQL template text to a tag as a string literal type.
The `sql.query("id")` key connects that query site to generated types without a
compiler/editor plugin. No handwritten TypeScript table schema or row interface is
required. `.inline/sql.ts` is generated and should accompany deployed source; rerun
generation after editing SQL or changing the schema. A stale SQL shape throws before
execution. Type checking without regeneration cannot verify changed SQL text.

## Deliberate first-version boundaries

- SELECT is the tested surface: raw SQL, optional predicates, nested Boolean groups,
  a materialized CTE, and window functions. This is not yet the full composition API
  or a promise of support for every PostgreSQL statement or Reylo feature.
- Branches are enumerated conservatively, up to 64 shapes per query. Conditions are
  not evaluated or correlated. Unreachable combinations can therefore be checked.
- Fragment structure must be written directly in the template using `sql`, the
  three helpers, ternaries, or `&&` helper operands. No general function/variable/control-flow analysis,
  fragment arrays/spreads, loops, dynamic identifiers, or logical-AND fragment syntax.
  Ordinary parameter expressions can be arbitrary JavaScript: their values are
  never evaluated during analysis.
- The older named API returns a union across all analyzed shapes. The `.sqlts` mapper
  now specializes supported direct-return functions for known flags/literal choices;
  see `experiments/sqlts/README.md` for examples and conservative fallbacks.
- Equal-binding-count variants must have identical input contracts by position.
  Otherwise TypeScript could accept a tuple belonging to a different SQL branch.
  Generation rejects these ambiguous cases; use separate query IDs for now.
- The facade guarantees inferred types for registered shapes, not source-text
  identity inside the TypeScript checker. Reusing an ID with different SQL may pass
  ordinary TypeScript if the tuples fit, but generation rejects duplicate sites and
  runtime rejects unregistered shapes. `any`/assertions bypass static types as usual.
- SQL authoring errors (including clause order and missing columns) are caught by
  generation. Quoted/commented interpolations and authored `$1`/`:name` placeholders
  are rejected; all bound parameters must come from `${...}`.
- This uses Reylo internals from the public `reylo` and `@reylosql/postgres` 0.6.x releases (checked per minor release in
  `src/adapter/reylo.ts`). It is experimental code,
  not an official Reylo integration or a production-ready library.

## Verification and measurements

```sh
bun run typecheck         # validate SQL and regenerate types, then bun check
bun check                 # full existing check suite, including SQL validation
bun run test:bundle       # execute a standalone demo bundle; check no analyzer leaks
bun run bench:runtime     # construction + compile, and compile-only microbenchmarks
```

`bun check` runs this package's existing `check` script. Inside the typecheck
pipeline, `bun check --no-script` explicitly selects Bun's built-in checker.
`bun run typecheck:bun` checks only TypeScript against the current generated
artifact; it does not validate SQL edits or refresh schema-derived types. Use
`bun run typecheck` for development and CI SQL/type validation.
`bun run typecheck:tsgo` remains available as a compiler compatibility check.
The SQL analysis time is additional to Bun's reported checker time.

The tests compare conditional query results with direct PostgreSQL, verify SQL/value
separation and immutability, test analysis failures and atomic output, and include
negative TypeScript assertions for inferred inputs and results. Runtime measurements
exclude database/network latency and schema freshness checks. They are local
microbenchmarks, not application throughput claims.

## IDE workflow and preview boundaries

```sh
bun run dev:types                         # regenerate on saved queries.ts changes
bun run inspect examples/queries.ts searchUsers # full source alternatives in a terminal
bun run bench:preview                     # no DB connection required
bun run test:watch                        # exercise save/failure/recovery workflow
```

The watcher debounces and serializes generation. Failed SQL retains the last good
artifact and prints the error. Until fixed, generated type hovers describe the last
successful analysis. Schema changes need an explicit `bun run generate`; the watcher
tracks saved `examples/**/queries.ts` files, not database migrations or unsaved text.

Live previews use the editor's document contents, showing the complete root query
when hovering inside its template. Each alternative lists truthy/falsy source
conditions and `$n` binding expressions. Expressions are never evaluated. These are
possible source paths, not proof of reachability or the eventual runtime query.
Hover rendering itself does not contact PostgreSQL. Separately, the editor validates
unsaved SQL against the development database after a 250 ms pause. It underlines SQL
errors in the original TypeScript (including nested fragments), deduplicates errors
shared by variants, and clears them when corrected. Superseded results are discarded.
One isolated analyzer runs at a time, with a 15 second timeout and a 256-distinct-shape
limit per document. It uses the project's environment / `.env` and Reylo schema cache,
never executes application source, and does not replace `.inline/sql.ts`.
Saving rechecks the document; schema freshness follows Reylo's refresh policy.
`bun run typecheck` remains the authoritative SQL + TypeScript check. Generated type
hovers still update on generation and describe the last successful analysis.

The live server only previews inline template sites in open documents; it does not
follow function calls/imports to produce a query preview on arbitrary caller variables.
The normal TypeScript server still supplies types there. Source path expansion is
bounded at 64; hovers show at most 8 alternatives and about 24 KB of content, with
an explicit truncation notice. `inspect` prints all paths within the extraction budget.
Preview documents are bounded at 500 KB and cache entries at 32. Syntax errors or
unsupported fragments display an unavailable message rather than a guessed query.

The protocol tests launch both the preview server and the same TypeScript 7 LSP
configured for Zed, verifying hover responses without database access and separately
checking live SQL diagnostics against the development database.
The standalone runtime bundle still contains no preview server or TypeScript parser.

## SQL completion in Zed

Inside a supported `sql.query(...)` template, type `u.` to suggest columns from a
`FROM ... u` or `JOIN ... u` binding. Tables and schemas are suggested after `FROM`
and `JOIN`, including `schema.`. Use Ctrl-Space / `editor: show completions` to open
the menu manually, arrow keys to choose, and Tab to accept. The server also advertises
dot and space triggers. Partial identifiers are replaced, including their suffix.

Completion uses a read-only PostgreSQL catalog snapshot shared by all open documents.
It loads lazily/prefetches on opening inline SQL, caches for 60 seconds, and refreshes
on save. Concurrent requests share one refresh. It reads `DATABASE_URL` or the root
Reylo configuration's `direct_url` (including environment substitutions). No database
round trip is made for each warm completion; schema loading is separate from SQL
validation. Catalog loading is bounded at 50,000 rows and an 8 second timeout.

Column details show the declared **table** type/nullability, not query-result
nullability after joins. Conditional availability is labeled when a binding exists
only in some SQL alternatives. SQL comments, string values and `${...}` JavaScript
expressions do not receive SQL suggestions; TypeScript handles those expressions.

Completion tracks CTE/subquery output columns (aliases, wildcards, column lists,
chained/recursive CTEs and data-modifying CTE `RETURNING`), ordinary/correlated/LATERAL
SELECT scopes, and INSERT/UPDATE/DELETE/MERGE targets. INSERT column lists and conflict
targets, UPDATE SET targets versus expressions, DELETE USING, RETURNING and EXCLUDED
inside ON CONFLICT DO UPDATE have separate visibility rules. MERGE distinguishes
matched, not-matched-by-target and not-matched-by-source branches, including SET,
INSERT column lists and RETURNING. JOIN ON excludes later joins; UNION ORDER BY
uses the set result columns rather than leaking a branch alias.

Functions, aggregates and window functions come from `pg_proc`, including accessible
custom functions, overloads, named OUT/TABLE columns and composite return columns.
Scalar table functions and WITH ORDINALITY expose their output names. Function-name
completion shows signatures; hover the function name for all cached overloads. The
server also provides LSP signature help with active argument tracking. Zed currently
may prefer TypeScript's enclosing template-tag signature in its argument popup;
function hover and the completion menu provide SQL signatures independently.

Open **examples/completion/queries.ts** for ten typed examples, including MERGE,
array unnesting and anonymous records. The exported
functions construct queries only; importing or running the file executes no writes.
Use Ctrl-Space, arrow keys and Tab inside their templates.

Output-name inference is a completion aid, not a replacement for PostgreSQL analysis.
Simple column/cast/function types are shown when known; unresolved expressions show
`SQL expression`, and projected-result nullability is explicitly not inferred here.
Polymorphic arrays, ranges and composite records resolve when their argument types
prove an output shape. Anonymous records use explicit SQL definitions such as
`AS r(id int, name text)`. Unknown or conflicting types stay `SQL expression`;
PostgreSQL implicit coercion/overload ranking, named function arguments, all
polymorphic combinations, DDL completion and every grammar corner are not claimed. SQL scopes and
expression inference are bounded at 24 nested levels and 256 scopes per alternative;
the catalog is limited to 50,000 table-column rows, 10,000 functions and 10,000 types.
The existing 64 source-path budget still applies. Completion/coloring tolerate
unfinished TypeScript/templates and skip unsupported query sites independently.
Generation remains strict and requires the supported static fragment language. Reylo diagnostics and CLI checking
remain authoritative for query validity and actual inferred result types.

## SQL coloring, refresh and portable editor server

SQL inside existing `sql.query("name")` and nested `sql` templates is colored by
LSP semantic tokens. The project enables Zed's `semantic_tokens: "combined"` for
TypeScript/TSX: SQL keywords, identifiers, functions, comments and literals receive
colors, while `${...}` retains ordinary TypeScript highlighting. It requires no
query API change or replacement TypeScript grammar. Styling is lexical assistance;
a colored identifier is not proof that it exists. Escaped source characters that
cannot be mapped exactly are left to the base highlighting.

Completion cancellation and document versions suppress superseded responses. A save
that arrives during a catalog read invalidates that snapshot and causes a fresh
read. Catalog changes revalidate open SQL documents. SQL/config-file change events
are registered with editors that support dynamic file watchers. The LSP command
`reylo.inline.refreshSchema` explicitly refreshes catalog metadata and diagnostics;
saving a query also refreshes the catalog. No database DDL is monitored continuously.
After applying a migration, run `bun run typecheck` to refresh generated types too.
The integration suite changes/drops a disposable column and verifies all three
surfaces: completion, unsaved diagnostics and generated types, with last-good
artifact preservation on failure.

The Zed extension resolves `node_modules/reylo-inline-sql-experiment` in the consumer
workspace, with this source checkout as a development fallback. Workers use the
consumer's project root and environment/configuration. See `editors/zed/README.md`
for installation and direct-server configuration. This removes the fixed local
checkout requirement; publishing/versioning the private experiment remains separate.

### Completion measurements

Run `bun run bench:completion`; results are printed and saved to
`work/completion-bench.json`. It measures fresh parsing, cached completion, edited
sources and SQL coloring with the live catalog, plus a synthetic 1,000-table /
50,000-column schema, 10,000 functions and 64 source alternatives. Database catalog loading is measured
separately. These are local server timings, excluding editor rendering and transport;
the completion machinery is absent from the application runtime bundle.

On the development Mac (Bun 1.4.4, arm64), the latest run measured warm p95 of
0.08 ms for a direct alias, 0.21 ms for CTE/LATERAL, 0.14 ms with 50,000 columns,
1.82 ms for a 1,000-table menu, 0.44 ms for a prefix search across 10,000 functions,
and 1.21 ms for 64 alternatives. Edited-source p95 was 1.56–4.79 ms; the first parser
initialization reached 20 ms. The initial live catalog read took 65 ms. SQL coloring
for the playground took 4.59 ms on its first pass and reused cached tokens afterward.
Re-run locally rather than treating these samples as latency guarantees.

Query IDs are deliberately unchanged. Removing their explicit spelling needs an
alternative way to connect a source template to generated TypeScript signatures;
plain tagged-template types cannot inspect the SQL string. Any automatic-identity
experiment should be opt-in and preserve the current named-query API and checks.

The native nameless-query capability experiment is available as
`bun run experiment:nameless`. On the installed toolchain its first integration
gate is blocked: Bun does not invoke content mappers, and TypeScript rejects them
for built-in `.ts` extensions. The positive-control custom-extension mapper works.
See `experiments/nameless/README.md` for measured results and the distinct generated-
source/custom-extension alternatives.

A separate generated-source `.auto` prototype is now available under
`experiments/auto`. Run `bun run auto:check`, `bun run auto:demo`, or
`bun run auto:build`. Open that folder as its own Zed project for mapped inferred
types, SQL previews and diagnostics. Read `experiments/auto/README.md` for its
explicit transform/check/editor workflow and remaining boundaries. The named API
and its ordinary TypeScript server are unchanged.

## No-generation `.sqlts` experiment

`experiments/sqlts` supplies inline SQL types through TypeScript 7.1 content mapping,
without generated source files. It uses plain `sql` queries and `sql.fragment`
pieces, with a loader for direct execution on both Node and Bun. Run
`bun run sqlts:check`, `bun run sqlts:demo` or `bun run sqlts:demo:bun`.
Open that directory as its own Zed project for native mapper types and SQL hovers.
See `experiments/sqlts/README.md` for setup, exact commands and boundaries.
The Bun runtime is supported by the loader; its built-in checker cannot replace
the mapper-capable TypeScript checker. No Cloudflare deployment support is claimed.

## Comparative runtime benchmark

Run `bun run bench:compare` to compare direct `pg`, plain Reylo, Drizzle, and the
inline `.sqlts` implementation on Node and Bun. The harness validates rows,
bindings, and PostgreSQL plans before measuring construction, execution,
throughput, and fresh/cached startup. It creates and drops a separate benchmark
schema; existing demo data is unchanged. See `scripts/comparison/README.md` for
methodology, sample controls, limitations, and saved results.

## SQLTS shared fragments, mutations and deployment

The no-generation `.sqlts` workflow now supports bounded shared fragment functions/constants
across relative `.sqlts` imports. See `experiments/shared-queries` for readable queries and
inferred callers. `bun run sqlts:check:all` checks every mapper-enabled example project;
`bun run sqlts:shared` runs the read-only demo.

INSERT/UPDATE/DELETE/UPSERT, bulk arrays, writable CTEs and RETURNING have native
checker and Node/Bun runtime regressions with transaction rollback. Equivalent SQL
branches and repeated query sites reuse analysis within a transform without bypassing
subsequent schema validation.

`bun run sqlts:pack` makes a SQLTS tarball; install it with `reylo@0.6` and `@reylosql/postgres@0.6` from npm. An optional `sqlts:build` moves analysis
to deployment build time. See `experiments/sqlts/PORTABILITY.md` for setup, exact timing
and remaining boundaries. These additions preserve the existing named API.

### Affected-row counts

`await query.runWithMetadata(db)` returns `{ rows, affectedRows, command }`.
`rows` keeps the same inferred/decoded `Row[]` as `.run(db)`. `affectedRows` is
`number | null`: the native top-level write count, or `null` when the client
omits reliable metadata. Zero is a real count; it is never inferred from
`rows.length`. `command` is the driver's command tag or `null`.

```ts
const result = await renameOrganization(orgId, name).runWithMetadata(db);
if (result.affectedRows === null) {
  console.log("Count unavailable from this client");
} else {
  console.log(`Updated ${result.affectedRows} users`);
}
```

No extra count query or `RETURNING` clause is added. Parameter validation,
encoding, decoding, schema freshness, and query observation remain active.
Without `RETURNING`, `rows` is `never[]`; `.run(db)` still returns that empty
array, and `.execute(db)` still follows inferred cardinality. Counts describe
the top-level command, not writes inside CTEs/triggers. SELECT reports zero
writes. PostgreSQL UPDATE counts matched rows even if values are unchanged.
Use the driver's transaction client when multiple statements must be atomic.

Verified on pg/postgres.js under Node and Bun, Bun.SQL, and browser PGlite.
PGlite 0.4.6 supplies `affectedRows` without `command`. Clients that discard
metadata and counts outside the safe integer range yield `null`, not a guess.
Execution features not yet provided: COPY streaming and a multi-statement
migration runner. Keep using your driver and dbmate for those jobs.

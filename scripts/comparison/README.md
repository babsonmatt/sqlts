# PostgreSQL comparison benchmark

From the repository root, with the existing `DATABASE_URL` configured:

```sh
bun run bench:compare
bun run bench:compare --runtime=node
bun run bench:compare --runtime=bun
# Focus on request-path costs; skip the separate startup trials.
bun run bench:compare --skip-startup
```

The Bun command is the coordinator. Measurements run in fresh child processes
using the selected runtime. The default runs both Node and Bun. Versions and the
machine description are recorded, without the connection string.

This compares direct `pg`, native Reylo `.sql` imports, Drizzle's normal PostgreSQL
select builder, and our no-generation `.sqlts` imports. Drizzle is pinned to 0.45.4
as a development dependency. All four use `pg` 8.23.1 and a four-connection pool.

## Reproducibility and safety

Each invocation creates its own UUID-named PostgreSQL schema with 20,000 synthetic
users and an `(org_id, id)` index. It removes that schema in `finally`, including on
ordinary benchmark errors. Existing demo tables are not modified. The configured
database user needs permission to create schemas. Fixture sources, native Reylo
caches, and results stay under `work/comparison/run-*`; they are not app artifacts.

Before timing, every provider must return identical rows and bindings and the same
structural `EXPLAIN (FORMAT JSON, COSTS OFF)` plan. All optional predicate combinations,
empty searches, and SQL-looking input are checked. SQL strings may differ in
identifier quoting, whitespace, and parentheses; SQL text and plans are saved.

Default measurements:

- Eight rounds, rotating provider order equally, with warmup for every provider.
- 5,000 constructions per round: build and materialize SQL/parameters. This includes
  our optional `.compile()` inspection copy and Drizzle's `.toSQL()`. Native Reylo
  selects one pre-analyzed statement and binds parameters; it does not build SQL.
  Inputs alternate between two org IDs, and a ring retains compiled results so the
  JIT cannot discard materialization. All reported percentiles use nearest rank.
- Two execution modes: **build + execute** constructs a fresh query per request;
  **execute prebuilt** constructs it once outside timing and reuses fixed bindings.
  Both modes include parameter handling/copying inside execution, the driver,
  database round trip and result decoding. Neither includes module startup or SQL
  analysis. Each runs 100 serial executions per round: 800 requests per provider,
  workload, and mode. Both receive equal warmup, and mode order alternates.
- `pairedDeltaUs` is the nearest-rank median of eight differences between the two
  modes' per-round median latencies (build minus prebuilt). It can be negative
  due to noise. It is not a profiler's exact attribution of construction cost.
- Four concurrent workers, 100 requests each per round, using four established pool
  connections, for each execution mode. Report median throughput over eight rounds. This is closed-loop
  throughput, not a saturation/load-generator or production capacity claim.
- Three workloads: a 20-row page, 20 rows with optional search/email predicates,
  and 1,000 rows to expose result-handling costs.
- Four fresh-process startup trials per provider, each followed by another fresh
  process reusing the same project's analysis cache. New fixture `package.json`
  files isolate Reylo's cache roots. Cache entry counts are asserted, not assumed.

Startup wall time includes launching the process, loading modules and loaders,
analysis, the first 20-row query, writing the small measurement record, and closing
the pool. Internal import/analysis and first-query timings are also recorded.
“Fresh” means no project analysis cache; PostgreSQL and OS caches are not flushed.
Drizzle and direct `pg` do not create analysis caches, so their two startup labels
are just separate process measurements.

The same native schema freshness checks and decoding behavior remain enabled for
Reylo and the inline implementation. An untimed driver-call audit records actual
SQL requests for three newly built queries versus three executions of a reused
query. It exposes extra schema-check round trips instead of hiding them.

## Interpret the comparison

The comparison uses **no named server-prepared statements** in either mode.
Build + execute uses Drizzle's normal select builder and `.execute()`. Reusing that
builder alone would still compile SQL on each `.execute()` in the pinned Drizzle
version. For execute-prebuilt, its `.prepare("")` compiles once client-side while
an empty statement name keeps PostgreSQL preparation unnamed, like the other
providers. The untimed driver audit rejects any nonempty statement name. Query
results and SQL bindings must match across both modes before timing.

For `pg`, prebuilt reuses text and a parameter array; for plain Reylo, it reuses
its executable and parameter object; for inline SQL, it reuses the query returned
by the SQL tag. Our `.run()` still clones parameter values to preserve isolation.
No provider returns cached rows: every measured execution reaches PostgreSQL.

Prebuilt is a fixed-query/fixed-values experiment to separate costs, not an API
for applying arbitrary new request parameters to a previously built inline query.
The normal conditional-request workload remains build + execute.

Direct `pg` and Drizzle use normal result decoding; Reylo uses its own. Fixtures
use only int4, text and nullable text so JavaScript results match. These numbers do
not characterize bigint/date/JSON conversion, writes, joins, network latency,
garbage-collection profiles, named prepared statements, or editor performance.

Do not read a single machine's microseconds as an overall ORM ranking. The useful
questions are where overhead occurs, whether it adds database round trips, and how
startup and larger results change the comparison. Raw request samples and round
samples are retained so outliers are visible.

Output: `work/comparison/latest.json`, plus the measurement with its UTC timestamp and generated
fixtures under the printed run directory. Run directories are uniquely named, not
reused. The coordinator drops its database fixture before exiting successfully.

For a quick harness smoke check (not publishable benchmark data):

```sh
BENCH_ROUNDS=1 BENCH_ITERATIONS=5 BENCH_BUILDS=100 BENCH_STARTUPS=1 bun run bench:compare --runtime=bun
```

Environment variables can also increase the default sample counts. Counts must be
positive integers; startup trials are capped at 20.

Implementation references: [Drizzle node-postgres integration](https://orm.drizzle.team/docs/get-started-postgresql),
[select builder](https://orm.drizzle.team/docs/select), and
[prepared query API](https://orm.drizzle.team/docs/perf-queries).

## First baseline finding (October 25, 2026)

The original driver audit found six database requests for three newly built inline
queries, versus three for the other warmed providers. Reusing one inline query
also produced three requests. Each new query previously constructed a new Reylo
executable; Reylo 0.5.0 caches schema freshness by executable identity.

The runtime now lazily retains one executable per query ID and analyzed SQL shape,
scoped to the `createSql` instance. Parameter snapshots and supplied clients remain
specific to each invocation. Replacing a shape's metadata replaces its executable.
The cache does not disable or alter Reylo's freshness interval: it still detects
schema changes when the next check is due. The driver audit should now show three
calls for three warmed executions, including freshly built queries.

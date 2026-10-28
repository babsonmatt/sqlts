# dbmate + SQLTS

An isolated, executable integration demo. From this repository:

```sh
bun run dbmate:install
bun run demo:migrations
```

The installer downloads dbmate **2.37.0** from its official GitHub release and verifies
the pinned SHA-256 digest. It installs only into ignored `work/tools/`; nothing is
published or installed globally. macOS/Linux arm64/x64 assets are supported.

The demo uses `SQLTS_MIGRATION_ADMIN_URL`, falling back to `DATABASE_URL`, to connect
to the local PostgreSQL server. That account needs permission to create databases.
Remote hosts are refused. It creates a random `sqlts_dbmate_*` database and a temporary
project under `work/`, then removes both in `finally`. Only the newly created database
is dropped. Existing demo databases, schemas and seeds are untouched. Connections
are not written to files or reports. A missing local SSL mode defaults to `disable`;
an explicitly configured mode is retained.

## What it proves

- A baseline SQL migration creates `users`; a SQLTS query selecting the future
  `display_name` column fails the SQL-aware check and editor diagnostics.
- Two concurrent dbmate processes use its PostgreSQL migration lock to apply the
  nullable-column migration once. Running it again is a no-op.
- Without source edits, the open editor clears that error, suggests the column,
  and infers `display_name: string | null`. Native checking verifies nullable and
  non-null assignments using positive and negative assertions.
- Node and Bun execute the query and return the expected row, including null.
- A type-changing migration replaces previously successful string inference with
  `number | null`, breaking the caller. Rollback restores its types and check.
- A deliberately failing transactional migration leaves neither its new column nor
  its ledger entry. Rolling back/remigrating the addition also removes/restores
  completion and diagnostics in the running editor.

The authored query and caller are in `template/`. The runner copies them to a
throwaway project; it does not generate query code or handwritten result types.
`template/tsconfig.json` is intentionally outside automatic example checking: its
column is absent until this isolated workflow applies the second migration. Oxc
excludes it; the demo explicitly runs the native SQL-aware checker against the copy.
The report is `work/dbmate-demo-results.json`.

## Refreshing an existing application

Keep using the application's migration runner. After its DDL completes, notify SQLTS
and run a fresh SQL-aware check. For the private installed SQLTS package:

```sh
dbmate --no-dump-schema --migration-lock migrate --strict
node node_modules/@sqlts/core/src/sqlts/cli.js refresh-schema --project .
node node_modules/@sqlts/core/src/sqlts/cli.js check -p tsconfig.json
```

In a script, preserve the migration exit status. The demo's adapter signals after
both successful and failed dbmate execution: earlier migrations in a batch or
nontransactional DDL can commit before a later failure. Refreshing is not reporting
success, retrying a migration, or rolling it back. Run the success-path check only
when migration succeeds; inspect/check the actual schema separately after failure.
The manual refresh command is also available as `bun run sqlts:refresh` in this checkout.

The migration connection and Reylo's effective development connection must select
the same database. `.reylo.yaml`/`.reylo.yml` `direct_url` takes precedence over a
`DATABASE_URL` assumption. The isolated demo uses an explicit environment-backed
`direct_url` for the temporary database and overrides `REYLO_CONFIG` in its child
processes. The integration does not guess or rewrite another project's credentials.

## How editor refresh works

`refresh-schema` atomically replaces `.sqlts-schema-revision` at the nearest package
root with a random revision. Ignore this file in version control. It contains no SQL,
credentials or generated types. Nested tsconfigs in that package use the same signal.
Both editor services watch it; no application code or DDL runs in the editor.

The preview server reloads its catalog. The native content mapper changes its
configuration identity and replaces its analysis worker, giving Reylo a fresh
in-memory schema cache immediately. Other open projects are reopened in that worker.
Disk cache validation remains Reylo's responsibility. Source preparation reuse still
works between refreshes. A schema refresh resets worker caches broadly; this is not
per-table dependency tracking and has no effect on the application's query request path.
The editor client must support native TypeScript's registered file watches (as Zed
does). Existing editor processes need a restart once to load this updated implementation.
The tests exercise real LSP servers; no fresh graphical Zed installation is claimed.

## Boundaries

This is an integration demo and a generic schema-refresh command, not a new migration
engine. The runner owns migration history, ordering, locking and recovery. Dbmate's
version ledger does not enforce checksums of already-applied files. Nontransactional
failure recovery and production deployment compatibility require separate tests.
No DDL is applied by ordinary checking, hovering or application startup. PostgreSQL
schema changes are not proof of operationally safe production migrations.

References: [pinned dbmate documentation](https://github.com/amacneil/dbmate/tree/v2.37.0),
[PostgreSQL CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html).

# Shared fragments and mutations

`fragments.sqlts` exports ordinary functions and a constant with explicit `sql.fragment`.
`search.sqlts` reuses them in two projections. `mutations.sqlts` shows INSERT, conditional
UPDATE, conflict handling, array-based bulk insertion and DELETE with/without RETURNING.
`consumer.ts` demonstrates inferred types. No handwritten row interfaces or generation.

From the repository root:

```
bun run sqlts:shared:check
bun run sqlts:shared
```

The demo only reads existing users and prints compiled mutation SQL. The mutation
regression tests execute writes inside transactions and always roll them back.

Shared definitions support directly exported functions, const arrow functions and const
fragments in relative `.sqlts` imports, including aliased imports. Function bodies consist
of initialized const declarations followed by one return; use ternaries and SQL helpers
for optional structure. Use simple value parameters. No recursion, mutation, loops,
barrel re-exports, namespace imports or arbitrary fragment callbacks. Parameters inside
SQL may still use ordinary JavaScript expressions.

SQL is checked in the consumer's full scope, so `u` must exist and have the referenced
columns. A SQL error originating in a shared piece is reported at its use in the query.
The analyzer reads saved dependency files. Unsaved changes to shared files trigger a
fingerprint diagnostic in consumers instead of silently preserving stale SQL types.
Save the shared file and rerun the checker; restart the SQLTS language server if it
retains the previous dependency analysis. Local SQL edits retain their live mapping.

Each supported branch is checked. Known `onlyWithEmail: true` selects the inferred
non-null email branches; runtime booleans keep both possibilities.
See `reuse-demo.ts`, `reusable-queries.sqlts`, and `reusable-fragments.sqlts` for
shared-predicate narrowing through arrows and local forwarding wrappers. Run
`bun run sqlts:reuse` for the read-only demo.

SQL wildcard characters in the search value retain their ILIKE meaning.

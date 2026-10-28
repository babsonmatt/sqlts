# Advanced SQLTS examples

Open this repository root in Zed so its existing TypeScript mapper and SQL completion settings apply. The examples use the existing `reylo_inline_demo.users` table. Orders and manager links are small illustrative `VALUES` CTEs inside the SQL, not additional database tables. Nothing creates or changes seed data.

From the repository root:

```sh
bun run sqlts:advanced:check
bun run sqlts:advanced
bun run sqlts:advanced:test
```

The demo script includes the SQLTS preload. To run it directly:

```sh
bun --preload @sqlts/core/register experiments/advanced-queries/consumer.ts
```

Node works too:

```sh
node --env-file=.env --import @sqlts/core/register experiments/advanced-queries/consumer.ts
```

## What to explore

| File              | Query                        | Details                                                                                                               |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `directory.sqlts` | `directory(10, "team", 1)`   | Materialized CTE, nested optional OR search, aggregate `FILTER`, optional `HAVING`, inner join, `row_number()`        |
| `peers.sqlts`     | `nextPeers(10, true, false)` | Correlated `LEFT JOIN LATERAL`, per-row ordering/limit, optional inner predicate, optional outer non-null requirement |
| `spending.sqlts`  | `spending(10, true, 10000n)` | Orders CTE, conditional join predicate, left join, grouping, `coalesce`, optional `HAVING`, `dense_rank()`            |
| `hierarchy.sqlts` | `hierarchy(10, 1, 3)`        | Recursive CTE, `UNION ALL`, two joins per recursive step, depth bound, array path, cycle guard                        |

In `consumer.ts`, hover `members`, `peers`, `leaderboard`, `tree`, or individual fields. `contracts.ts` checks inferred types without annotating the returned rows. Control-Space after a table alias offers columns; hover the outer SQL tag to see the analyzed query alternatives.

## Details worth noticing

- Filtering `selected_users` changes the directory aggregates and ranking. Its minimum member count applies after the search. If you want whole-organization counts, put the search in a later CTE instead.
- A peer's columns are nullable because of the left join. `onlyContactable` changes the lateral subquery's candidate set; `requireMatch` drops users with no matching peer. Inferred types remain conservative across those variants.
- The paid-order condition lives in `ON`, preserving users without qualifying orders. Bob therefore appears with zero paid orders and zero cents. Moving that condition to the outer `WHERE` would remove him.
- The leaderboard's minimum spend is a `bigint` parameter, so use `10000n`. PostgreSQL `sum(integer)`, `count`, and rank functions produce bigint results here. `coalesce` supplies zero when the sum is null.
- Recursive traversal uses only users in the requested organization. The path guard prevents revisiting a user if links later contain a cycle. The current fixture is a simple chain; depth zero returns only the root. Reylo currently infers the path as `(number | null)[]`, conservatively allowing null array elements even though these paths contain IDs.
- Optional fragments change SQL structure, while interpolated values remain parameters. Both short `sql` fragments and explicit `sql.fragment` work. These examples use the shorter form.
- Search uses ILIKE patterns: `%` and `_` retain wildcard semantics. The verification script includes injection-like input to check it remains a value.

The check command targets this folder's tsconfig, including the queries, caller, and type contracts. No generation command is involved. The verification script assumes the normal four-user fixture and uses a read-only transaction. Schema inference still requires the development database connection.

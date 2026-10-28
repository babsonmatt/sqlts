# Nameless-query capability experiment

Run `bun run experiment:nameless` from the repository root. This creates disposable
compiler fixtures, verifies both negative and positive controls, removes the fixtures,
and writes measured compiler output to `work/nameless-probe.json`. It does not use the
database, execute application code, register an editor mapper, or alter the query API.

## Result on the installed toolchain

Bun 1.4.4-canary (checker TypeScript 7.0.2) and TypeScript 7.1.0-beta:

- Bun rejects `--runExternalCode` and does not invoke a configured content mapper.
- TypeScript rejects a content mapper for `.auto.ts` with TS18066: built-in extension.
- The same mapper works on a custom `.sqlts` extension (positive control).
- A generic tagged template receives `TemplateStringsArray`; its SQL text is typed
  as `string`, not a per-site literal. A normal string argument retains its literal
  type (positive control).

These are capability checks, not an implementation of a nameless query tag. If a
future toolchain changes the expected results, the probe fails and prompts a review.

## Why this matters

Two queries can have identical parameter types but completely different result
columns. Overloading a nameless tag on parameters cannot distinguish those queries.
A runtime-generated ID does not make the ID visible to the typechecker. Returning
`any`, `unknown`, or a union of all result shapes would lose the guarantees of the
existing named-query API.

`sql.auto` is not inherently required as permanent syntax. With source integration,
complete queries could use plain `sql` templates. However, this project's plain
`sql` currently constructs fragments. An opt-in module could expose plain `sql` for
queries and `sql.fragment` for fragments, without changing the existing module.
SQL keywords should not be used to guess whether a template is a complete query.

## Feasible follow-on approaches

1. A build/check transform can rewrite nameless sites to named calls in generated
   TypeScript, then run Bun's checker against that generated project and map errors
   back to source. Runtime transforms can use the same identities. This needs a
   separate editor integration for accurate per-site types in original `.ts` files;
   neither runtime rewriting nor fabricated SQL hovers is sufficient. Imports,
   cross-file result propagation, unsaved edits and stale artifacts must be tested.
2. A custom extension such as `.sqlts` can use TypeScript 7.1's content mapper and a
   runtime loader. This changes the file/checker workflow and must be an explicit
   separate experiment; it is not native Bun checking of ordinary `.ts` files.
3. Keep the existing named API. This preserves ordinary TypeScript files, current
   Bun checking and the existing TypeScript IDE integration.

The first capability gate did not pass for the originally proposed native workflow,
but a separate generated-source/editor workaround is now implemented in
`../auto`. It does not change this native capability result. See
`../auto/README.md` and run `bun run auto:check` to try the transform prototype.

References: [TypeScript content mappers](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/#content-mappers),
[Bun checker differences](https://bun.com/docs/runtime/check#differences-from-tsc).
The installed-toolchain probe, rather than assumptions about those docs, establishes
the specific limitations above.

The custom-extension follow-on is now implemented under `../sqlts`: a native
content mapper, Node/Bun loaders, and native language-server tests. It needs no
separate source generation step; see `../sqlts/README.md`. Ordinary `.ts` mapper
and native Bun-checker limitations above still apply.

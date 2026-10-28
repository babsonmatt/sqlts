# SQLTS for Zed

SQL coloring, table and column completion, and query previews for
[SQLTS](https://sqlts.dev) (`@sqlts/core`) in Zed.

Types and SQL errors come from TypeScript 7's own language server, not from this
extension; the settings below enable both.

## Install

1. In your project: `npm i @sqlts/core reylo@0.6 @reylosql/postgres@0.6 typescript@7.1.0-beta`.
2. Install this extension. Until it is in Zed's extension registry, clone
   [babsonmatt/sqlts](https://github.com/babsonmatt/sqlts), run
   `zed: install dev extension` and select `editors/zed` (Zed builds it; Rust must be installed).
3. Add to the project's `.zed/settings.json`, merging with existing settings:

```json
{
  "file_types": { "TypeScript": ["sqlts"] },
  "languages": {
    "TypeScript": {
      "language_servers": ["sqlts", "typescript-ls", "..."],
      "semantic_tokens": "combined"
    },
    "TSX": { "language_servers": ["sqlts", "typescript-ls", "..."], "semantic_tokens": "combined" }
  },
  "lsp": {
    "typescript-ls": {
      "binary": { "path": "node_modules/typescript/bin/tsc", "arguments": ["--lsp", "--stdio"] },
      "initialization_options": { "runExternalCode": true }
    }
  }
}
```

4. Restart the language servers (or reopen the project).

The `sqlts` server is opt-in, so it only runs in projects that list it.

## Runtime

The extension starts the project's installed `@sqlts/core` preview server with Node
(the `node` on your shell's PATH, else Zed's bundled Node). To use Bun instead:

```json
{ "lsp": { "sqlts": { "settings": { "runtime": "bun" } } } }
```

Neither runtime runs your application's preload hooks or imports application code.
The server reads the development database from the environment, `.env.local`, `.env`
or `.reylo.yaml`'s `direct_url`, the same as the type checker.

## What you get

- SQL inside `sql` templates is colored (semantic tokens).
- Ctrl-Space after `FROM schema.` or an alias such as `u.` completes tables and columns
  from the development database. The catalog is cached for 60 seconds; saving or running
  `sqlts refresh-schema --project .` after a migration refreshes it.
- Hovering a query call shows its SQL alternatives and `$n` bindings.

Opening the SQLTS source checkout itself also works: the extension then runs
`scripts/preview-server.ts` with Bun.

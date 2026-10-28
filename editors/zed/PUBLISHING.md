# Installing and publishing the SQLTS Zed extension

The extension (`sqlts-lsp`) is not in Zed's extension registry. Anyone can install it from a
clone of this repository today; publishing to the registry is optional and can happen any time.

## Install it locally (no registry needed)

Requirements: Zed, Rust installed through [rustup](https://rustup.rs) (Zed compiles the
extension), and a project that uses `@sqlts/core`.

1. Clone the repository:

   ```sh
   git clone https://github.com/babsonmatt/sqlts.git
   ```

2. In Zed, run `zed: install dev extension` from the command palette and choose the
   `editors/zed` folder of that clone. It appears in the Extensions panel as **SQLTS**.
3. In the project that uses SQLTS, install the packages and add the Zed settings from
   [README.md](README.md):

   ```sh
   npm i @sqlts/core reylo@0.6 @reylosql/postgres@0.6 typescript@7.1.0-beta
   ```

4. Reopen the project. Zed only applies a changed language-server list on reopen.

To check it works: hovering a query result in a `.ts` file shows its inferred row type, and
Ctrl-Space after `u.` inside a `sql` template lists the table's columns.

To update later: `git pull` in the clone, then click **Rebuild** on SQLTS in the Extensions
panel. If an earlier version is installed under a different name (Reylo Inline SQL Preview,
or an older SQLTS build with id `sqlts`), uninstall it first.

## Publish to the Zed registry

Publishing means a pull request to
[zed-industries/extensions](https://github.com/zed-industries/extensions). Once Zed merges it,
the extension is built and listed automatically. Zed's guides:
[prerequisites](https://zed.dev/docs/extensions/publishing/prerequisites) and
[publishing guide](https://zed.dev/docs/extensions/publishing/publishing-guide).

### Already done in this repository

- Id `sqlts-lsp`. Language-server extensions must end in `-lsp` or `-language-server`, and
  ids may not contain `zed` or `extension`. The id was free in the registry.
- `LICENSE` (MIT, an accepted license) inside `editors/zed`.
- `repository` and `authors = ["SQLTS <hello@sqlts.dev>"]` in `extension.toml`. The address
  forwards through Cloudflare Email Routing.
- The extension does not bundle a server; it starts the project's installed `@sqlts/core`.
- Tested as a dev extension in Zed against a project installed from npm.
- No secrets, keys or machine-specific paths in the repository or its history. Commits do
  carry the author's email (see "Git email" below).

### Zed's AI policy

Zed's [AI policy](https://github.com/zed-industries/extensions/blob/main/AI_POLICY.md) allows
AI-assisted code, but the pull request must come from a person:

- Write the pull request description and every reply to maintainers yourself. Quoted AI
  output must be in a `>` block, disclosed, and explained.
- You must be able to explain the extension in your own words.
- Autonomous agents may not open or drive the pull request.

You have 3 weeks to respond to review feedback before the pull request is closed. Each pull
request adds or updates exactly one extension.

### Steps

Before starting, push the commit you want to publish to `main`, and test that exact commit
as a dev extension. Zed asks that the submitted commit be the tested one.

```sh
# Fork zed-industries/extensions to your personal account (Zed prefers personal forks so
# staff can push fixes to the pull request) and clone it.
gh repo fork zed-industries/extensions --clone
cd extensions
git checkout -b add-sqlts-lsp

# Add this repository as a submodule. It must be an HTTPS URL, and the commit must be on a
# branch (main), not a detached commit.
git submodule add https://github.com/babsonmatt/sqlts.git extensions/sqlts-lsp
git -C extensions/sqlts-lsp checkout <tested commit on main>
git add extensions/sqlts-lsp
```

Add this to `extensions.toml`. `version` must match `editors/zed/extension.toml` at that
commit:

```toml
[sqlts-lsp]
submodule = "extensions/sqlts-lsp"
path = "editors/zed"
version = "0.1.0"
```

Then sort, commit, push and open the pull request:

```sh
pnpm install
pnpm sort-extensions
git add .gitmodules extensions.toml extensions/sqlts-lsp
git commit -m "Add sqlts-lsp"
git push -u origin add-sqlts-lsp
gh pr create --repo zed-industries/extensions --web
```

Title it `Add sqlts-lsp` (the repository's convention for new extensions), tick the
checklist, and describe the extension in your own words.

### Updating after it is published

Bump `version` in `editors/zed/extension.toml`, push to `main`, test as a dev extension, then
open a pull request in `zed-industries/extensions` that moves the `extensions/sqlts-lsp`
submodule to the new commit and updates `version` in `extensions.toml` to match. See Zed's
[updating guide](https://zed.dev/docs/extensions/publishing/updating-and-maintenance).

## Git email

Every commit records its author's email, and GitHub shows it on public commits. To keep
future commits private:

1. GitHub → Settings → Emails: tick **Keep my email addresses private** and **Block command
   line pushes that expose my email**. The page shows your `…@users.noreply.github.com`
   address.
2. Use that address for commits:

   ```sh
   git config --global user.email "<your noreply address>"
   ```

3. A commit made before this change is refused by the push block. Rewrite its author with
   `git commit --amend --reset-author --no-edit`, then push.

Earlier commits keep the old email unless the history is rewritten.

use zed_extension_api::{self as zed, settings::LspSettings, Command, LanguageServerId, Result, Worktree};

const PACKAGE_LAUNCHER: &str = "node_modules/@sqlts/core/src/sqlts/preview-cli.js";
const CHECKOUT_SERVER: &str = "scripts/preview-server.ts";

struct Sqlts;
impl zed::Extension for Sqlts {
    fn new() -> Self { Self }
    fn language_server_command(&mut self, id: &LanguageServerId, worktree: &Worktree) -> Result<Command> {
        let root = worktree.root_path();
        let env = worktree.shell_env();
        // Prefer the project's installed package. The SQLTS source checkout is a dev fallback.
        if worktree.read_text_file(PACKAGE_LAUNCHER).is_ok() {
            // `"lsp": { "sqlts": { "settings": { "runtime": "bun" } } }` runs the server on Bun.
            let runtime = LspSettings::for_worktree(id.as_ref(), worktree).ok()
                .and_then(|s| s.settings)
                .and_then(|s| s.get("runtime").and_then(|r| r.as_str()).map(str::to_owned))
                .unwrap_or_else(|| "node".into());
            let node = match worktree.which("node") {
                Some(node) => node,
                None => zed::node_binary_path()?,
            };
            return Ok(Command {
                command: node,
                args: vec![
                    format!("{root}/{PACKAGE_LAUNCHER}"),
                    "--runtime".into(), runtime,
                    "--project".into(), root,
                ],
                env,
            });
        }
        if worktree.read_text_file(CHECKOUT_SERVER).is_ok() {
            let bun = worktree.which("bun").ok_or("The SQLTS source checkout needs Bun on PATH")?;
            return Ok(Command {
                command: bun,
                args: vec![
                    "--no-env-file".into(),
                    format!("--config={root}/editors/zed/server.bunfig.toml"),
                    format!("{root}/{CHECKOUT_SERVER}"),
                    "--project".into(), root,
                ],
                env,
            });
        }
        Err("Install @sqlts/core in this project (npm i @sqlts/core) to enable SQLTS previews".into())
    }
}
zed::register_extension!(Sqlts);

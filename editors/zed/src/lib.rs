use zed_extension_api::{self as zed, Command, LanguageServerId, Result, Worktree};

struct InlinePreview;
impl zed::Extension for InlinePreview {
    fn new() -> Self { Self }
    fn language_server_command(&mut self, _: &LanguageServerId, worktree: &Worktree) -> Result<Command> {
        // Prefer the consumer's installed package. The source checkout is a dev fallback.
        let base = ["node_modules/reylo-inline-sql-experiment", "."].into_iter()
            .find(|base| worktree.read_text_file(&format!("{base}/scripts/preview-server.ts")).is_ok())
            .ok_or("Install reylo-inline-sql-experiment in this workspace, or open its source checkout")?;
        let bun = worktree.which("bun").ok_or("Bun must be available on PATH")?;
        let package = format!("{}/{base}", worktree.root_path());
        Ok(Command {
            command: bun,
            args: vec!["--no-env-file".into(), format!("--config={package}/editors/zed/server.bunfig.toml"), format!("{package}/scripts/preview-server.ts"), "--project".into(), worktree.root_path()],
            env: worktree.shell_env(),
        })
    }
}
zed::register_extension!(InlinePreview);

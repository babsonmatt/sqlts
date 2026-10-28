import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlDiagnostic } from "./diagnostics.ts";

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Job = { generation: number; uri: string; file: string; text: string; version: number };

/** Debounce edits; run at most one isolated analyzer; discard superseded results. */
export class DiagnosticScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Job>();
  private active?: { job: Job; child: ReturnType<typeof Bun.spawn> };
  private stopped = false;
  private serial = 0;
  private generations = new Map<string, number>();
  constructor(
    private readonly version: (uri: string) => number | undefined,
    private readonly publish: (
      uri: string,
      version: number | undefined,
      diagnostics: SqlDiagnostic[],
    ) => void,
    private readonly projectRoot = process.cwd(),
  ) {}
  schedule(uri: string, text: string, version: number) {
    this.cancel(uri);
    if (this.stopped || !uri.startsWith("file:")) return;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      return;
    }
    const path = relative(this.projectRoot, file);
    if (path.startsWith("..") || isAbsolute(path)) return;
    this.publish(uri, version, []);
    if (!text.includes(".inline/sql")) return;
    const generation = ++this.serial;
    this.generations.set(uri, generation);
    this.timers.set(
      uri,
      setTimeout(() => {
        this.timers.delete(uri);
        this.pending.set(uri, { uri, file, text, version, generation });
        void this.drain();
      }, 250),
    );
  }
  cancel(uri: string) {
    this.generations.delete(uri);
    clearTimeout(this.timers.get(uri));
    this.timers.delete(uri);
    this.pending.delete(uri);
    if (this.active?.job.uri === uri) this.active.child.kill();
  }
  close(uri: string) {
    this.cancel(uri);
    this.publish(uri, undefined, []);
  }
  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.generations.clear();
    this.active?.child.kill();
  }
  private async drain() {
    if (this.stopped || this.active) return;
    const job = this.pending.values().next().value;
    if (!job) return;
    this.pending.delete(job.uri);
    const unavailable: SqlDiagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 2,
        source: "reylo-inline",
        message:
          "SQL validation unavailable or timed out. Check the development database configuration and run bun run typecheck for details.",
      },
    ];
    let diagnostics = unavailable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          `--config=${resolve(codeRoot, "editors/zed/server.bunfig.toml")}`,
          fileURLToPath(new URL("../scripts/diagnostics-worker.ts", import.meta.url)),
        ],
        {
          cwd: this.projectRoot,
          stdin: new Blob([JSON.stringify(job)]),
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      this.active = { job, child };
      timer = setTimeout(() => child.kill(), 15_000);
      const output = await new Response(child.stdout).text();
      if ((await child.exited) === 0) diagnostics = JSON.parse(output) as SqlDiagnostic[];
    } catch {
      /* Surface availability, never connection strings or child stacks. */
    } finally {
      clearTimeout(timer);
      this.active = undefined;
      if (
        !this.stopped &&
        this.version(job.uri) === job.version &&
        this.generations.get(job.uri) === job.generation
      )
        this.publish(job.uri, job.version, diagnostics);
      void this.drain();
    }
  }
}

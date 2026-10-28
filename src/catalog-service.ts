import { fileURLToPath } from "node:url";
import type { Catalog } from "./catalog.ts";
import { runWorker, type Worker } from "./worker.ts";
const empty: Catalog = { relations: [], schemas: [], keywords: [] };
interface Options {
  projectRoot?: string;
  changed?: () => void;
  load?: () => Promise<Catalog>;
  now?: () => number;
}
/** Single-flight catalog reads. A refresh during a read must invalidate that read. */
export class CatalogService {
  private catalog = empty;
  private expires = 0;
  private loading?: Promise<Catalog>;
  private child?: Worker["child"];
  private stopped = false;
  private revision = 0;
  constructor(
    private readonly unavailable: () => void = () => {},
    private readonly options: Options = {},
  ) {}
  peek(): Catalog {
    return this.catalog;
  }
  refresh() {
    this.revision++;
    this.expires = 0;
    return this.get();
  }
  stop() {
    this.stopped = true;
    this.child?.kill();
  }
  get(): Promise<Catalog> {
    if (this.stopped) return Promise.resolve(empty);
    if (this.loading) return this.loading;
    if ((this.options.now ?? Date.now)() < this.expires) return Promise.resolve(this.catalog);
    this.loading = this.reload().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  private async reload(): Promise<Catalog> {
    // Discard old metadata if a migration/save occurs while its read is in flight.
    while (!this.stopped) {
      const revision = this.revision;
      try {
        const next = await (this.options.load ? this.options.load() : this.read());
        if (this.stopped) break;
        if (revision !== this.revision) continue;
        const changed = JSON.stringify(next) !== JSON.stringify(this.catalog);
        this.catalog = next;
        this.expires = (this.options.now ?? Date.now)() + 60_000;
        if (changed) this.options.changed?.();
      } catch {
        if (this.stopped) break;
        if (revision !== this.revision) continue;
        this.catalog = empty;
        this.expires = (this.options.now ?? Date.now)() + 5000;
        this.unavailable();
      }
      break;
    }
    return this.stopped ? empty : this.catalog;
  }
  private async read(): Promise<Catalog> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { child, result } = runWorker(
        fileURLToPath(new URL("../scripts/catalog-worker.ts", import.meta.url)),
        this.options.projectRoot ?? process.cwd(),
      );
      this.child = child;
      timer = setTimeout(() => child.kill(), 8000);
      const { code, stdout } = await result;
      if (code !== 0) throw new Error("Catalog unavailable");
      return JSON.parse(stdout) as Catalog;
    } finally {
      clearTimeout(timer);
      this.child = undefined;
    }
  }
}

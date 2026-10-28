import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  watch,
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  type FSWatcher,
} from "node:fs";

/** Native TS ignores a disk event when its open overlay already has that text.
 * A separate, never-opened watch file lets saved dependency changes invalidate
 * mapper transforms too. It contains only a counter, never source or credentials. */
export class DependencyWatch {
  private directory = mkdtempSync(join(tmpdir(), "reylo-sqlts-watch-"));
  readonly file = join(this.directory, "saved-dependencies.json");
  private watchers: FSWatcher[] = [];
  private paths: string[] = [];
  private stamps = new Map<string, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private layout = "";
  private readonly changed?: () => void;
  constructor(changed?: () => void) {
    this.changed = changed;
    writeFileSync(this.file, "0");
  }
  private stamp(file: string) {
    try {
      return createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (error) {
      return `unreadable:${(error as NodeJS.ErrnoException).code}`;
    }
  }
  private schedule = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let changed = false;
      for (const file of this.paths) {
        const stamp = this.stamp(file);
        if (this.stamps.get(file) !== stamp) changed = true;
        this.stamps.set(file, stamp);
      }
      if (changed) {
        writeFileSync(this.file, String(++this.revision));
        this.changed?.();
      }
    }, 40);
    this.timer.unref();
  };
  update(paths: string[], snapshots?: ReadonlyMap<string, string>) {
    paths = [...new Set(paths)].sort();
    const directories = new Map<string, Set<string>>();
    for (const file of paths) {
      let directory = dirname(file),
        child = basename(file);
      while (!existsSync(directory) && dirname(directory) !== directory) {
        child = basename(directory);
        directory = dirname(directory);
      }
      const names = directories.get(directory) ?? new Set<string>();
      names.add(child);
      directories.set(directory, names);
    }
    const layout = JSON.stringify(
      [...directories].map(([directory, names]) => [directory, [...names]]),
    );
    if (layout === this.layout && JSON.stringify(paths) === JSON.stringify(this.paths)) return;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.paths = paths;
    this.layout = layout;
    this.stamps = new Map(paths.map((file) => [file, snapshots?.get(file) ?? this.stamp(file)]));
    try {
      for (const [directory, names] of directories) {
        const watcher = watch(directory, { persistent: false }, (_event, name) => {
          if (!name || names.has(String(name))) this.schedule();
        });
        watcher.on("error", this.schedule);
        this.watchers.push(watcher);
      }
      // Catch a save between reading the dependency graph and installing watches.
      this.schedule();
    } catch (error) {
      for (const watcher of this.watchers) watcher.close();
      throw error;
    }
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

import { watch } from "node:fs";
import { generate } from "./generate.ts";
let running = false,
  dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
async function drain() {
  if (running) {
    dirty = true;
    return;
  }
  running = true;
  do {
    dirty = false;
    try {
      const files = await Array.fromAsync(new Bun.Glob("examples/**/queries.ts").scan("."));
      await generate(files);
      console.log("Types updated. Watching saved query files…");
    } catch (error) {
      console.error("Generation failed; last successful types retained.\n" + String(error));
    }
  } while (dirty);
  running = false;
}
const watcher = watch("examples", { recursive: true }, (_event, filename) => {
  if (!filename || !/(^|[/\\])queries\.ts$/.test(filename)) return;
  clearTimeout(timer);
  timer = setTimeout(() => void drain(), 200);
});
await drain();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    watcher.close();
    clearTimeout(timer);
    process.exit(0);
  });

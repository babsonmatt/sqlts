import { parentPort, type MessagePort } from "node:worker_threads";
import { loadSqlts } from "./load.ts";
parentPort!.on(
  "message",
  async ({ file, done, port }: { file: string; done: Int32Array; port: MessagePort }) => {
    try {
      port.postMessage({ code: await loadSqlts(file) });
    } catch (error) {
      port.postMessage({ error: String(error) });
    } finally {
      port.close();
      Atomics.store(done, 0, 1);
      Atomics.notify(done, 0);
    }
  },
);

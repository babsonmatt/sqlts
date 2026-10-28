import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";
let worker: Worker | undefined;
export function loadSync(file: string): string {
  worker ??= new Worker(new URL("./node-worker.ts", import.meta.url));
  worker.unref();
  const done = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  worker.postMessage({ file, done, port: port2 }, [port2]);
  const waited = Atomics.wait(done, 0, 0, 30_000);
  const reply = receiveMessageOnPort(port1)?.message as
    | { code?: string; error?: string }
    | undefined;
  port1.close();
  if (!reply) {
    void worker.terminate();
    worker = undefined;
    throw Error(`${file}: SQL loader ${waited === "timed-out" ? "timed out" : "failed"}`);
  }
  if (reply.error) throw Error(reply.error);
  if (typeof reply.code !== "string") throw Error("SQL loader returned no code");
  return reply.code;
}

import { Worker } from "node:worker_threads";
import type { Handlers, OpenParams, TransformParams, Transform } from "../adapter/reylo.ts";

/** A bounded worker lifetime gives migration refresh a genuinely fresh native schema
 * cache, without deleting Reylo's disk cache or relying on its refresh TTL. Calls are
 * serialized by the mapper. A refresh reopens other projects before serving requests. */
export class AnalysisClient {
  private worker?: Worker;
  private serial = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  private projects = new Map<string, OpenParams>();
  private start() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./analysis-worker.ts", import.meta.url));
    this.worker = worker;
    worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      const p = this.pending.get(message.id);
      if (!p) return;
      this.pending.delete(message.id);
      if (message.error) p.reject(Error(message.error));
      else p.resolve(message.value);
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
    worker.on("error", failed);
    worker.on("exit", (code) =>
      failed(Error(`SQLTS analysis worker exited (${code}); restart the language server`)),
    );
    return worker;
  }
  private call<T>(method: string, params: unknown): Promise<T> {
    const worker = this.start(),
      id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      worker.postMessage({ id, method, params });
    });
  }
  async open(p: OpenParams) {
    const result = await this.call<Awaited<ReturnType<Handlers["openProject"]>>>("open", p);
    this.projects.set(p.projectHandle, p);
    return result;
  }
  async close(p: { projectHandle: string }) {
    this.projects.delete(p.projectHandle);
    return this.call<object>("close", p);
  }
  transform(p: TransformParams) {
    return this.call<Transform>("transform", p);
  }
  async refresh() {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
    for (const p of this.projects.values()) await this.call("open", p);
  }
}

import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { DependencyWatch } from "./dependency-watch.ts";
import { projectDependencies } from "./dependencies.ts";
import { schemaSignal, schemaRevision } from "./schema-refresh.ts";
import { AnalysisClient } from "./analysis-client.ts";
import type { OpenParams, TransformParams } from "../adapter/reylo.ts";
const rpc = new URL("./rpc.js", import.meta.resolve("reylo")).href;
const { serve } = (await import(rpc)) as { serve: (handlers: Record<string, Function>) => void };
const analysis = new AnalysisClient();
const watches = new Map<string, DependencyWatch>();
const revisions = new Map<string, string>();
process.on("exit", () => {
  for (const watch of watches.values()) watch.close();
});
let pending: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = pending.then(fn);
  pending = result.catch(() => {});
  return result;
};
serve({
  initialize: () => ({
    protocolVersion: 1,
    positionEncoding: "utf-16",
    diagnosticSource: "reylo-sqlts",
  }),
  openProject: (p: OpenParams) =>
    serial(async () => {
      const signal = schemaSignal(dirname(p.configFileName)),
        revision = schemaRevision(signal);
      if (revisions.has(signal) && revisions.get(signal) !== revision) await analysis.refresh();
      revisions.set(signal, revision);
      const result = await analysis.open(p);
      const dependencies = projectDependencies(p.configFileName);
      dependencies.snapshots.set(
        signal,
        revision ? createHash("sha256").update(revision).digest("hex") : "unreadable:ENOENT",
      );
      let watch = watches.get(p.projectHandle);
      if (!watch) {
        watch = new DependencyWatch();
        watches.set(p.projectHandle, watch);
      }
      watch.update([...dependencies.watchedFiles, signal], dependencies.snapshots);
      return {
        ...result,
        configIdentity: JSON.stringify([result.configIdentity, dependencies.identity, revision]),
        watchedFiles: [...new Set([...result.watchedFiles, watch.file])],
      };
    }),
  closeProject: (p: { projectHandle: string }) =>
    serial(() => {
      watches.get(p.projectHandle)?.close();
      watches.delete(p.projectHandle);
      return analysis.close(p);
    }),
  transform: (p: TransformParams) => serial(() => analysis.transform(p)),
});

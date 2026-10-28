import { parentPort } from "node:worker_threads";
import { analyze, SqltsError, tooling } from "./analyze.ts";
import type { OpenParams, TransformParams } from "../adapter/reylo.ts";
const handlers = tooling.mapperHandlers();
const opened = new Set<string>();
parentPort!.on(
  "message",
  async ({
    id,
    method,
    params,
  }: {
    id: number;
    method: "open" | "close" | "transform";
    params: OpenParams & TransformParams;
  }) => {
    try {
      let value;
      if (method === "open") {
        if (opened.has(params.projectHandle)) await handlers.closeProject(params);
        value = await handlers.openProject(params);
        opened.add(params.projectHandle);
      } else if (method === "close") {
        value = await handlers.closeProject(params);
        opened.delete(params.projectHandle);
      } else {
        try {
          const { runtime: _runtime, ...result } = await analyze(params, handlers);
          value = result;
        } catch (error) {
          value = {
            extension: ".ts",
            text: "export {};",
            mappings: [],
            diagnostics:
              error instanceof SqltsError
                ? error.diagnostics
                : [
                    {
                      start: 0,
                      length: Math.min(1, params.content.length),
                      code: 1,
                      messageText: String(error),
                    },
                  ],
          };
        }
      }
      parentPort!.postMessage({ id, value });
    } catch (error) {
      parentPort!.postMessage({ id, error: String(error) });
    }
  },
);

import { resolve } from "node:path";
import { tooling } from "../src/adapter/reylo.ts";
import { diagnose } from "../src/diagnostics.ts";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin) as { text: string; file: string };
const handlers = tooling.mapperHandlers();
const projectHandle = `editor-${crypto.randomUUID()}`;
try {
  await handlers.openProject({ projectHandle, configFileName: resolve("tsconfig.json") });
  const diagnostics = await diagnose(input.text, input.file, handlers, projectHandle);
  process.stdout.write(JSON.stringify(diagnostics));
} finally {
  await handlers.closeProject({ projectHandle });
  await tooling.releaseConnections();
}

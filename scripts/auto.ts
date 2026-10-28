import { resolve } from "node:path";
import {
  buildAuto,
  codeRoot,
  defaultProject,
  mapCheckOutput,
  publishAuto,
  removeAuto,
} from "../src/auto/project.ts";
process.chdir(codeRoot);
const mode = process.argv[2] ?? "check";
if (!["check", "run", "build", "generate"].includes(mode))
  throw Error("Use check, run, build or generate");
const snapshot = await buildAuto(defaultProject);
if (mode !== "generate") {
  const child = Bun.spawn(
    [process.execPath, "check", "--no-script", "-p", resolve(snapshot.directory, "tsconfig.json")],
    { cwd: snapshot.directory, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  process.stdout.write(mapCheckOutput(stdout + stderr, snapshot));
  if (code !== 0) {
    await removeAuto(snapshot);
    process.exit(code);
  }
}
await publishAuto(snapshot);
if (mode === "run" || mode === "build") {
  const entry = resolve(snapshot.directory, process.argv[3] ?? "demo.ts");
  if (!snapshot.files.some((f) => f.shadow === entry))
    throw Error("Entry must be one of the experimental project files");
  if (mode === "run") {
    const child = Bun.spawn([process.execPath, entry], {
      cwd: codeRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  } else {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      outdir: resolve(defaultProject, ".auto/dist"),
      minify: true,
    });
    if (!result.success) throw Error(result.logs.map((log) => log.message).join("\n"));
    console.log("Built standalone auto demo:", result.outputs[0]!.path);
  }
}
console.log("Auto snapshot:", snapshot.directory);

import { AutoGenerationError, buildAuto, codeRoot } from "../src/auto/project.ts";
process.chdir(codeRoot);
const input = JSON.parse(await Bun.stdin.text()) as {
  root: string;
  snapshotParent?: string;
  documents?: Record<string, string>;
};
try {
  const snapshot = await buildAuto(input.root, input.documents, input.snapshotParent);
  console.log("AUTO_RESULT:" + JSON.stringify({ snapshot }));
} catch (error) {
  console.log(
    "AUTO_RESULT:" +
      JSON.stringify({
        errors: error instanceof AutoGenerationError ? error.diagnostics : [],
        message: String(error),
      }),
  );
  process.exitCode = 1;
}

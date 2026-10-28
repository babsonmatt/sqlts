import { expect, test } from "bun:test";

// Generated helper types and shared-fragment checks must not trip noUnusedLocals,
// which strict projects enable and editors report as "declared but never used".
test.each(["sqlts", "user-search", "shared-queries"])(
  "%s checks cleanly with noUnusedLocals",
  async (example) => {
    const p = Bun.spawn(
      [
        Bun.which("node")!,
        "--env-file=.env",
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--runExternalCode",
        "--noUnusedLocals",
        "-p",
        `experiments/${example}/tsconfig.json`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    expect(out + err).not.toContain("__sqlts_");
    expect(code, out + err).toBe(0);
  },
  60_000,
);

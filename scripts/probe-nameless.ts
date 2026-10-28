import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Capability experiment only. No query API, checker config or application file is changed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "work"), { recursive: true });
const dir = await mkdtemp(join(root, "work/nameless-probe-"));
async function run(command: string[]) {
  const child = Bun.spawn(command, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: (stdout + stderr).trim().replaceAll(dir, "<probe>") };
}
const bun = [process.execPath, "check", "--no-script"];
const tsc = [Bun.which("node")!, join(root, "node_modules/typescript/bin/tsc")];
try {
  const mapper = join(dir, "node_modules/nameless-probe-mapper");
  await mkdir(mapper, { recursive: true });
  await writeFile(
    join(mapper, "package.json"),
    JSON.stringify({
      name: "nameless-probe-mapper",
      version: "0.0.0",
      type: "module",
      typescript: {
        contentMapper: { exec: ["node", "mapper.mjs"], compilerOptions: [], dynamicConfig: true },
      },
    }),
  );
  const rpc = pathToFileURL(join(root, "node_modules/reylo/src/rpc.js")).href;
  await writeFile(
    join(mapper, "mapper.mjs"),
    `
    import {serve} from ${JSON.stringify(rpc)};
    import {appendFileSync} from "node:fs";
    serve({
      initialize:()=>({protocolVersion:1,positionEncoding:"utf-8",diagnosticSource:"nameless-probe"}),
      openProject:()=>({configIdentity:"probe",watchedFiles:[],optionDiagnostics:[]}),
      closeProject:()=>({}),
      transform:({content})=>{
        appendFileSync(new URL("./called.txt",import.meta.url),"called\\n");
        return {extension:".ts",text:content.replace('"mapper must run"',"42"),mappings:[],diagnostics:[]};
      }
    });
  `,
  );
  const config = (file: string, extension?: string) => ({
    compilerOptions: { strict: true, noEmit: true, target: "esnext", types: [] },
    files: [file],
    ...(extension
      ? { contentMappers: [{ package: "nameless-probe-mapper", extensions: [extension] }] }
      : {}),
  });
  await writeFile(join(dir, "query.auto.ts"), 'export const value: number = "mapper must run";\n');
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify(config("query.auto.ts", ".auto.ts")));
  const bunFlag = await run([...bun, "-p", "tsconfig.json", "--runExternalCode"]);
  assert.notEqual(bunFlag.code, 0);
  assert.match(bunFlag.output, /Unknown flag.*runExternalCode/);
  const bunMapper = await run([...bun, "-p", "tsconfig.json"]);
  assert.notEqual(bunMapper.code, 0);
  assert.match(bunMapper.output, /TS2322/);
  assert.equal(
    await Bun.file(join(mapper, "called.txt")).exists(),
    false,
    "Bun unexpectedly invoked the mapper; revisit the experiment",
  );
  const tsBuiltIn = await run([
    ...tsc,
    "-p",
    "tsconfig.json",
    "--runExternalCode",
    "--pretty",
    "false",
  ]);
  assert.notEqual(tsBuiltIn.code, 0);
  assert.match(tsBuiltIn.output, /TS18066/);
  await writeFile(join(dir, "query.sqlts"), 'export const value: number = "mapper must run";\n');
  await writeFile(
    join(dir, "tsconfig.custom.json"),
    JSON.stringify(config("query.sqlts", ".sqlts")),
  );
  const customControl = await run([
    ...tsc,
    "-p",
    "tsconfig.custom.json",
    "--runExternalCode",
    "--pretty",
    "false",
  ]);
  assert.equal(customControl.code, 0, customControl.output);
  assert.doesNotMatch(customControl.output, /error TS/);
  assert.equal(await readFile(join(mapper, "called.txt"), "utf8"), "called\n");
  await writeFile(
    join(dir, "literal.ts"),
    [
      "declare function tag<const S extends TemplateStringsArray>(strings: S): S[0];",
      "const result = tag`SELECT id FROM users`;",
      'const exact: "SELECT id FROM users" = result;',
    ].join("\n"),
  );
  await writeFile(join(dir, "tsconfig.literal.json"), JSON.stringify(config("literal.ts")));
  const literal = await run([...bun, "-p", "tsconfig.literal.json"]);
  assert.notEqual(literal.code, 0);
  assert.match(literal.output, /Type 'string' is not assignable/);
  // Ordinary string arguments *do* retain literals, so the generic/checker setup is valid.
  await writeFile(
    join(dir, "literal.ts"),
    [
      "declare function call<const S extends string>(text: S): S;",
      'const result = call("SELECT id FROM users");',
      'const exact: "SELECT id FROM users" = result;',
    ].join("\n"),
  );
  const stringControl = await run([...bun, "-p", "tsconfig.literal.json"]);
  assert.equal(stringControl.code, 0, stringControl.output);
  const report = {
    at: new Date().toISOString(),
    bun: Bun.version,
    bunTypeScript: process.versions.typescript,
    typescript: JSON.parse(
      await Bun.file(join(root, "node_modules/typescript/package.json")).text(),
    ).version,
    conclusion:
      "Native nameless SQL typing in ordinary .ts files is blocked on this toolchain. No API change shipped.",
    probes: { bunFlag, bunMapper, tsBuiltIn, customControl, literal, stringControl },
  };
  await writeFile(join(root, "work/nameless-probe.json"), JSON.stringify(report, null, 2) + "\n");
  console.table([
    { probe: "Bun mapper execution flag", result: "unsupported" },
    { probe: "Bun configured content mapper", result: "not invoked; original source checked" },
    { probe: "TypeScript mapper on .auto.ts", result: "rejected: built-in extension" },
    { probe: "TypeScript mapper on .sqlts", result: "works (positive control)" },
    { probe: "Tagged-template SQL literal type", result: "erased to string" },
    { probe: "Ordinary string literal type", result: "preserved (positive control)" },
  ]);
  console.log("All capability assertions passed. Report: work/nameless-probe.json");
} finally {
  await rm(dir, { recursive: true, force: true });
}

import { branchConstraints } from "./branch-constraints.ts";
import { mapProofSources } from "../branch-proof.ts";
import ts from "typescript-ast";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { expandFragments } from "./shared-fragments.ts";
import { extract } from "../extract.ts";
import { mapOffset, type AutoFile } from "../auto/transform.ts";

export interface Edit {
  start: number;
  end: number;
  text: string;
}
export function applyEdits(source: string, file: string, edits: Edit[]): AutoFile {
  let cursor = 0,
    text = "";
  const segments: AutoFile["segments"] = [];
  for (const edit of edits.toSorted((a, b) => a.start - b.start)) {
    if (edit.start < cursor) throw Error("Overlapping sqlts edits");
    const chunk = source.slice(cursor, edit.start);
    if (chunk.length)
      segments.push({
        original: cursor,
        generated: text.length,
        originalLength: chunk.length,
        generatedLength: chunk.length,
        exact: true,
      });
    text += chunk;
    segments.push({
      original: edit.start,
      generated: text.length,
      originalLength: edit.end - edit.start,
      generatedLength: edit.text.length,
      exact: false,
    });
    text += edit.text;
    cursor = edit.end;
  }
  const tail = source.slice(cursor);
  segments.push({
    original: cursor,
    generated: text.length,
    originalLength: tail.length,
    generatedLength: tail.length,
    exact: true,
  });
  text += tail;
  return { original: file, shadow: file, source, text, segments, ids: [] };
}
export function prepare(
  source: string,
  file: string,
  tolerant = false,
  options: { readSource?: (file: string) => string; mergeEquivalentPaths?: boolean } = {},
) {
  if (source.length > 500_000) throw Error("sqlts files are limited to 500 KB");
  const sf = ts.createSourceFile(
    file + ".ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (n) => (n === sf.fileName ? sf : undefined);
  const program = ts.createProgram([sf.fileName], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const syntax = program.getSyntacticDiagnostics(sf);
  if (syntax.length && !tolerant)
    throw Error(syntax.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (n) =>
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "reylo-sqlts-experiment",
    );
  if (imports.length > 1) throw Error("Use one sql import per .sqlts module");
  const statement = imports[0];
  if (!statement)
    return {
      source,
      file,
      analysis: applyEdits(source, file, []),
      queries: [],
      edits: [],
      sites: [],
      prefix: "",
      name: "",
      statement: undefined,
    };
  const bindings = statement.importClause?.namedBindings;
  if (
    !bindings ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 ||
    (bindings.elements[0]!.propertyName ?? bindings.elements[0]!.name).text !== "sql" ||
    statement.importClause?.name ||
    statement.importClause?.isTypeOnly
  )
    throw Error('Import { sql } (optionally aliased) from "reylo-sqlts-experiment"');
  const binding = bindings.elements[0]!;
  const name = binding.name.text;
  let prefix = "__sqlts_" + createHash("sha256").update(file).digest("hex").slice(0, 12) + "_";
  while (source.includes(prefix)) prefix += "_";
  const isSql = (node: ts.Node) =>
    ts.isIdentifier(node) && checker.getSymbolAtLocation(node)?.declarations?.includes(binding);
  const isSqlMethod = (node: ts.Node, methods: readonly string[]) =>
    ts.isPropertyAccessExpression(node) &&
    isSql(node.expression) &&
    methods.includes(node.name.text);
  // Only structural composition gives a nested tag fragment meaning. Do not infer
  // context through arbitrary callbacks, string templates, or unknown functions.
  const isFragmentOperand = (node: ts.TaggedTemplateExpression) => {
    let current: ts.Node = node;
    while (current.parent) {
      const parent = current.parent;
      if (
        ts.isParenthesizedExpression(parent) ||
        (ts.isConditionalExpression(parent) &&
          (parent.whenTrue === current || parent.whenFalse === current)) ||
        (ts.isBinaryExpression(parent) &&
          parent.right === current &&
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        current = parent;
        continue;
      }
      if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === current))
        return isSqlMethod(parent.expression, ["where", "and", "or"]);
      if (ts.isTemplateSpan(parent) && parent.expression === current) {
        const tag = parent.parent.parent;
        return (
          ts.isTaggedTemplateExpression(tag) &&
          (isSql(tag.tag) || isSqlMethod(tag.tag, ["fragment"]))
        );
      }
      return false;
    }
    return false;
  };
  const edits: Edit[] = [
    {
      start: statement.moduleSpecifier.getStart(sf),
      end: statement.moduleSpecifier.end,
      text: JSON.stringify("./.inline/sql.ts"),
    },
  ];
  const sites: { id: string; start: number; end: number; tag: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      if (isSql(node.tag) && !isFragmentOperand(node)) {
        let ancestor: ts.Node | undefined = node.parent;
        while (ancestor) {
          if (ts.isTaggedTemplateExpression(ancestor))
            throw Error(
              "Nested sql tags must be composed directly through templates or sql.where/and/or",
            );
          ancestor = ancestor.parent;
        }
        const id = "q" + sites.length;
        sites.push({ id, start: node.tag.getStart(sf), end: node.tag.end, tag: prefix + id });
        edits.push({
          start: node.tag.getStart(sf),
          end: node.tag.end,
          text: `${name}.query(${JSON.stringify(id)})`,
        });
      } else if (
        ts.isPropertyAccessExpression(node.tag) &&
        isSql(node.tag.expression) &&
        node.tag.name.text === "fragment"
      ) {
        edits.push({ start: node.tag.getStart(sf), end: node.tag.end, text: name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (sites.length > 32) throw Error("sqlts files are limited to 32 query sites");
  const analysis = applyEdits(source, file, edits);
  // Parse as TS regardless of the authored extension. No physical virtual file is needed.
  const shared = expandFragments(analysis.text, file, name, options.readSource);
  const expanded = applyEdits(analysis.text, file, shared.edits);
  const authored = (start: number, end: number) => {
    const segment = analysis.segments.find(
      (s) => s.exact && start >= s.generated && end <= s.generated + s.generatedLength,
    );
    return segment
      ? {
          start: segment.original + start - segment.generated,
          end: segment.original + end - segment.generated,
        }
      : undefined;
  };
  const queries = extract(
    expanded.text,
    resolve(dirname(file), "__analysis.ts"),
    64,
    tolerant,
    options.mergeEquivalentPaths ?? true,
    (expression) => {
      const value = shared.values.get(expression);
      return value
        ? { expression: value.text, proof: mapProofSources(value.proof, authored) }
        : undefined;
    },
    2_000_000,
  );
  const compatible = branchConstraints(sf, checker);
  for (const q of queries) {
    const display = (text: string) => {
      for (const [expression, guard] of shared.guards)
        text = text.replaceAll(expression, guard.text);
      return text;
    };
    for (const alternative of q.alternatives) {
      alternative.conditions = alternative.conditions.map(display);
      alternative.guards = alternative.guards?.map((g) => {
        const truthy = g.text.startsWith("truthy: ");
        const sharedGuard = shared.guards.get(g.text.slice(truthy ? 8 : 7));
        if (sharedGuard)
          return { text: display(g.text), proof: mapProofSources(sharedGuard.proof, authored) };
        g = { ...g, text: display(g.text) };
        if (g.start === undefined || g.end === undefined) return { text: g.text };
        const segment = expanded.segments.find(
          (s) => s.exact && g.start! >= s.generated && g.end! <= s.generated + s.generatedLength,
        );
        if (!segment) return { text: g.text };
        const start = segment.original + g.start - segment.generated;
        const end = segment.original + g.end - segment.generated;
        const original = analysis.segments.find(
          (s) => s.exact && start >= s.generated && end <= s.generated + s.generatedLength,
        );
        return original
          ? {
              text: g.text,
              start: original.original + start - original.generated,
              end: original.original + end - original.generated,
            }
          : { text: g.text };
      });
    }
    // Joined fragments often share a guard. Discard only contradictory reads of
    // proven immutable bindings, before PostgreSQL sees impossible SQL shapes.
    const keep = q.alternatives
      .map((v, i) => (compatible(v.guards ?? []) ? i : -1))
      .filter((i) => i >= 0);
    q.variants = keep.map((i) => q.variants[i]!);
    q.sourceMaps = keep.map((i) => q.sourceMaps[i]!);
    q.alternatives = keep.map((i) => q.alternatives[i]!);
    q.start = mapOffset(expanded, q.start, true);
    q.end = mapOffset(expanded, q.end, true);
    q.tagEnd = mapOffset(expanded, q.tagEnd, true);
    q.sourceMaps = q.sourceMaps.map((points) =>
      points.map((at) => (at === undefined ? undefined : mapOffset(expanded, at, true))),
    );
  }
  if (queries.reduce((n, q) => n + q.variants.length, 0) > 256)
    throw Error("sqlts files are limited to 256 SQL shapes");
  return {
    source,
    file,
    analysis,
    queries,
    edits,
    sites,
    prefix,
    name,
    statement,
    dependencies: shared.dependencies,
    fingerprints: shared.fingerprints,
    checker,
  };
}
export function mappings(output: AutoFile) {
  return output.segments
    .filter((s) => s.generatedLength > 0)
    .map((s) => [
      s.generated,
      s.generatedLength,
      s.original,
      s.originalLength,
      s.exact ? 0 : 1,
      // Transformed tags/imports support inspection/navigation, never unsafe edit-back.
      s.exact ? (1 << 20) - 1 : 1 | 2 | 8 | 16 | 32,
    ]);
}
export { mapOffset };

import ts from "typescript-ast";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { offset, position, type Position, type Range } from "../preview.ts";

export interface Segment {
  original: number;
  generated: number;
  originalLength: number;
  generatedLength: number;
  exact: boolean;
}
export interface AutoFile {
  original: string;
  shadow: string;
  source: string;
  text: string;
  segments: Segment[];
  ids: string[];
}
export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
export function transformAuto(
  source: string,
  original: string,
  shadow: string,
  project: string,
  artifact: string,
): AutoFile {
  const sf = ts.createSourceFile(original, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === original ? sf : undefined);
  const program = ts.createProgram([original], { noLib: true, noResolve: true }, host),
    checker = program.getTypeChecker();
  const edits: { start: number; end: number; text: string }[] = [];
  const declarations = new Set<ts.Declaration>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    if (
      !module.startsWith(".") ||
      resolve(dirname(original), module) !== resolve(project, "sql.ts")
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (
      !bindings ||
      !ts.isNamedImports(bindings) ||
      bindings.elements.length !== 1 ||
      (bindings.elements[0]!.propertyName ?? bindings.elements[0]!.name).text !== "sql"
    )
      throw Error(
        `${original}: import only { sql } (optionally aliased) from the experimental sql.ts`,
      );
    declarations.add(bindings.elements[0]!);
    let path = relative(dirname(shadow), artifact).replaceAll("\\", "/");
    if (!path.startsWith("./") && !path.startsWith("../")) path = "./" + path;
    edits.push({
      start: statement.moduleSpecifier.getStart(sf),
      end: statement.moduleSpecifier.end,
      text: JSON.stringify(path),
    });
  }
  // Preserve static imports/re-exports that leave the mirrored project.
  for (const statement of sf.statements) {
    const module =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (!module || !ts.isStringLiteral(module) || !module.text.startsWith(".")) continue;
    const target = resolve(dirname(original), module.text);
    const inside = relative(project, target);
    if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith("../")) continue;
    let path = relative(dirname(shadow), target).replaceAll("\\", "/");
    if (!path.startsWith("./") && !path.startsWith("../")) path = "./" + path;
    edits.push({ start: module.getStart(sf), end: module.end, text: JSON.stringify(path) });
  }
  const ids: string[] = [],
    occurrences = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isPropertyAccessExpression(node.tag) &&
      node.tag.name.text === "auto" &&
      ts.isIdentifier(node.tag.expression)
    ) {
      const symbol = checker.getSymbolAtLocation(node.tag.expression);
      if (symbol?.declarations?.some((d) => declarations.has(d))) {
        let parent: ts.Node | undefined = node.parent;
        while (parent) {
          if (ts.isTaggedTemplateExpression(parent))
            throw Error(`${original}: complete .auto queries cannot be nested inside fragments`);
          parent = parent.parent;
        }
        const body = node.template.getText(sf),
          count = occurrences.get(body) ?? 0;
        occurrences.set(body, count + 1);
        const id =
          "auto_" +
          fingerprint(
            JSON.stringify([relative(project, original).replaceAll("\\", "/"), body, count]),
          ).slice(0, 24);
        ids.push(id);
        edits.push({
          start: node.tag.getStart(sf),
          end: node.tag.end,
          text: `${node.tag.expression.text}.query(${JSON.stringify(id)})`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  edits.sort((a, b) => a.start - b.start);
  let cursor = 0,
    text = "";
  const segments: Segment[] = [];
  for (const edit of edits) {
    if (edit.start < cursor) throw Error("Overlapping auto transform");
    const chunk = source.slice(cursor, edit.start);
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
  return { original, shadow, source, text, segments, ids };
}
export function mapOffset(file: AutoFile, at: number, toOriginal: boolean): number {
  const from = toOriginal ? "generated" : "original",
    size = toOriginal ? "generatedLength" : "originalLength",
    to = toOriginal ? "original" : "generated";
  const segment =
    file.segments.find((s) => at >= s[from] && at < s[from] + s[size]) ?? file.segments.at(-1)!;
  return (
    segment[to] +
    (segment.exact
      ? Math.max(0, at - segment[from])
      : toOriginal
        ? 0
        : Math.min(Math.max(0, at - segment[from]), segment.generatedLength - 1))
  );
}
export function generatedPosition(file: AutoFile, at: Position) {
  return position(file.text, mapOffset(file, offset(file.source, at), false));
}
export function originalRange(file: AutoFile, range: Range): Range {
  return {
    start: position(file.source, mapOffset(file, offset(file.text, range.start), true)),
    end: position(file.source, mapOffset(file, offset(file.text, range.end), true)),
  };
}

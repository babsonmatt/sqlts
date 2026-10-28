import ts from "typescript-ast";

/** Simplify redundant nullable-unknown unions in type syntax, never source strings or metadata. */
export function normalizeGeneratedType(text: string): string {
  const prefix = "type Generated = ";
  const file = ts.createSourceFile(
    "generated.ts",
    prefix + text + ";",
    ts.ScriptTarget.Latest,
    true,
  );
  const edits: { start: number; end: number }[] = [];
  const unwrap = (node: ts.TypeNode): ts.TypeNode =>
    ts.isParenthesizedTypeNode(node) ? unwrap(node.type) : node;
  const isNull = (node: ts.TypeNode) =>
    ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
  const visit = (node: ts.Node) => {
    if (ts.isUnionTypeNode(node)) {
      const members = node.types.map(unwrap);
      if (
        members.some((member) => member.kind === ts.SyntaxKind.UnknownKeyword) &&
        members.every((member) => member.kind === ts.SyntaxKind.UnknownKeyword || isNull(member))
      ) {
        edits.push({ start: node.getStart(file) - prefix.length, end: node.end - prefix.length });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const edit of edits.reverse())
    text = text.slice(0, edit.start) + "unknown" + text.slice(edit.end);
  return text;
}

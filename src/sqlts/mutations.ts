import ts from "typescript-ast";

/** Find writes, including writes nested in closures and parameter initializers.
 * A target predicate lets callers distinguish writes to their parameter bindings
 * from new/shadowed locals. Without one, any write makes a helper unproven. */
export function hasWrites(
  node: ts.Node,
  matches: (target: ts.Node) => boolean = () => true,
): boolean {
  if (ts.isIdentifier(node) && ["eval", "arguments"].includes(node.text)) return true;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    matches(node.left)
  )
    return true;
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
    matches(node.operand)
  )
    return true;
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const target = node.initializer;
    if (
      ts.isVariableDeclarationList(target)
        ? target.declarations.some((d) => matches(d.name))
        : matches(target)
    )
      return true;
  }
  // A var declaration can redeclare and assign a parameter's existing binding.
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.parent) &&
    !(node.parent.flags & ts.NodeFlags.BlockScoped) &&
    matches(node.name)
  )
    return true;
  return !!ts.forEachChild(node, (child) => hasWrites(child, matches));
}

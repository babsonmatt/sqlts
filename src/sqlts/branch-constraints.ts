import ts from "typescript-ast";
import type { BranchProof } from "../branch-proof.ts";
import type { BranchGuard } from "../extract.ts";
import { hasParameterWrites } from "./result-types.ts";

type Fact = { key: string; inverted: boolean };
/** Only compare repeat reads of immutable bindings. A matching spelling is not
 * identity, and mutable/global expressions must keep all possible combinations.
 * Do not constant-fold literal conditions: even explicitly disabled branches retain
 * SQL diagnostics. This only removes contradictory combinations of linked pieces. */
export function branchConstraints(sf: ts.SourceFile, checker: ts.TypeChecker) {
  const nodes = new Map<string, ts.Expression>();
  const index = (n: ts.Node) => {
    if (ts.isExpression(n)) nodes.set(`${n.getStart(sf)}:${n.end}`, n);
    ts.forEachChild(n, index);
  };
  index(sf);
  const writes = new Map<ts.Node, boolean>();
  const negate = (fact: Fact | undefined): Fact | undefined =>
    !fact ? undefined : { ...fact, inverted: !fact.inverted };
  const source = (e: ts.Expression): Fact | undefined => {
    if (ts.isParenthesizedExpression(e)) return source(e.expression);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken)
      return negate(source(e.operand));
    if (!ts.isIdentifier(e)) return;
    const declaration = checker.getSymbolAtLocation(e)?.valueDeclaration;
    if (!declaration) return;
    if (ts.isParameter(declaration)) {
      const fn = declaration.parent;
      if (!(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
        return;
      if (!writes.has(fn)) writes.set(fn, hasParameterWrites(fn, checker));
      if (writes.get(fn)) return;
    } else if (
      !(ts.isVariableDeclaration(declaration) && declaration.parent.flags & ts.NodeFlags.Const)
    )
      return;
    return { key: `binding:${declaration.getStart(sf)}`, inverted: false };
  };
  const proof = (p: BranchProof): Fact | undefined => {
    if (p.kind === "source") {
      const e = nodes.get(`${p.start}:${p.end}`);
      return e ? source(e) : undefined;
    }
    if (p.kind === "not") return negate(proof(p.value));
    return;
  };
  return (guards: readonly BranchGuard[]) => {
    const seen = new Map<string, boolean>();
    for (const guard of guards) {
      const expected = guard.text.startsWith("truthy: ")
        ? true
        : guard.text.startsWith("falsy: ")
          ? false
          : undefined;
      if (expected === undefined) continue;
      const node = nodes.get(`${guard.start}:${guard.end}`);
      const fact = guard.proof ? proof(guard.proof) : node ? source(node) : undefined;
      if (!fact) continue;
      const value = fact.inverted ? !expected : expected;
      if (seen.has(fact.key) && seen.get(fact.key) !== value) return false;
      seen.set(fact.key, value);
    }
    return true;
  };
}

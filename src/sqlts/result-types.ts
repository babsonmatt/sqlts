import { hasWrites } from "./mutations.ts";
import type { BranchProof } from "../branch-proof.ts";
import ts from "typescript-ast";
import type { ExtractedQuery } from "../extract.ts";
import type { Edit, prepare } from "./transform.ts";

// These helpers describe possible outcomes, not a single assumed execution.
// Intersection retains falsy possibilities for broad string/number parameters.
const helpers = (prefix: string) => [
  `type ${prefix}Falsy = false | "" | 0 | null | undefined;`,
  `type ${prefix}Truth<T> = ([Exclude<T, ${prefix}Falsy>] extends [never] ? never : true) | ([T & ${prefix}Falsy] extends [never] ? never : false);`,
  `type ${prefix}Eq<T, L> = ([T & L] extends [never] ? never : true) | ([Exclude<T, L>] extends [never] ? never : false);`,
  `type ${prefix}Not<T> = (true extends T ? false : never) | (false extends T ? true : never);`,
  `type ${prefix}And<A, B> = (false extends A ? false : never) | (true extends A ? B : never);`,
  `type ${prefix}Or<A, B> = (true extends A ? true : never) | (false extends A ? B : never);`,
  `type ${prefix}May<T, V, Row> = V extends T ? Row : never;`,
  `type ${prefix}Default<T, D> = Exclude<T, undefined> | (undefined extends T ? D : never);`,
  `type ${prefix}Coalesce<T, D> = Exclude<T, null | undefined> | ([T & (null | undefined)] extends [never] ? never : D);`,
];

/** The helpers `uses` references, directly or through other helpers. Unused ones would be reported by noUnusedLocals. */
export function resultTypeHelpers(prefix: string, uses: string) {
  const pending = helpers(prefix).map((text) => ({
    text,
    name: new RegExp(`\\b${/^type (\w+)/.exec(text)![1]}\\b`),
  }));
  const included: string[] = [];
  for (;;) {
    const found = pending.filter((helper) => helper.name.test(uses));
    if (!found.length) break;
    for (const helper of found) {
      pending.splice(pending.indexOf(helper), 1);
      included.push(helper.text);
      uses += "\n" + helper.text;
    }
  }
  return included.map((text) => text + "\n").join("");
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;

function literal(e: ts.Expression): string | undefined {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return JSON.stringify(e.text);
  if (ts.isNumericLiteral(e))
    return Number.isFinite(Number(e.text)) ? String(Number(e.text)) : undefined;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (e.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (
    ts.isPrefixUnaryExpression(e) &&
    ts.isNumericLiteral(e.operand) &&
    Number.isFinite(Number(e.operand.text))
  ) {
    if (e.operator === ts.SyntaxKind.MinusToken) return String(-Number(e.operand.text));
    if (e.operator === ts.SyntaxKind.PlusToken) return String(Number(e.operand.text));
  }
  return undefined;
}

function primitiveType(t: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(t)) return primitiveType(t.type);
  if (ts.isUnionTypeNode(t)) return t.types.every(primitiveType);
  return (
    [
      ts.SyntaxKind.BooleanKeyword,
      ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword,
      ts.SyntaxKind.UndefinedKeyword,
      ts.SyntaxKind.NeverKeyword,
    ].includes(t.kind) ||
    (ts.isLiteralTypeNode(t) && literal(t.literal as ts.Expression) !== undefined)
  );
}

function parameterType(p: ts.ParameterDeclaration, sf: ts.SourceFile): string | undefined {
  if (p.type) return p.type.getText(sf);
  if (!p.initializer) return undefined;
  const value = literal(p.initializer);
  if (value === undefined || value === "null") return undefined;
  if (value === "true" || value === "false") return "boolean";
  return value.startsWith('"') ? "string" : "number";
}

type QueryFunction = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
export interface ResultSpecialization {
  edits: Edit[];
  declarations: string[];
  fn: QueryFunction;
  rowAlias: string;
  tuple: string;
  depth: number;
  cardinality: string;
  queryError: string;
}

export function returnedExpression(
  fn: QueryFunction,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (!fn.body) return;
  const block = ts.isBlock(fn.body) ? fn.body : undefined;
  let expression = block
    ? ts.isReturnStatement(block.statements.at(-1)!)
      ? (block.statements.at(-1) as ts.ReturnStatement).expression
      : undefined
    : (fn.body as ts.Expression);
  for (let depth = 0; expression && depth < 16; depth++) {
    expression = unwrap(expression);
    if (!ts.isIdentifier(expression)) return expression;
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.type ||
      !declaration.initializer ||
      declaration.parent.parent.parent !== block ||
      !(declaration.parent.flags & ts.NodeFlags.Const)
    )
      return expression;
    expression = declaration.initializer;
  }
  return;
}

/** Generated signatures live at module scope. Do not move references to local
 * types, captured type parameters, or typeof function arguments out of scope. */
function canHoistParameterTypes(fn: QueryFunction, checker: ts.TypeChecker): boolean {
  const rootName = (name: ts.EntityName): ts.Identifier =>
    ts.isIdentifier(name) ? name : rootName(name.left);
  return fn.parameters.every((parameter) => {
    const type = parameter.type;
    if (!type) return true;
    let safe = true;
    const visit = (node: ts.Node) => {
      if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) {
        const name = ts.isTypeReferenceNode(node) ? node.typeName : node.exprName;
        if (ts.isIdentifier(name) || ts.isQualifiedName(name)) {
          const declarations = checker.getSymbolAtLocation(rootName(name))?.declarations ?? [];
          for (const declaration of declarations) {
            // Generic/mapped binders declared inside this type stay inside it.
            if (
              declaration.getSourceFile() === type.getSourceFile() &&
              declaration.pos >= type.pos &&
              declaration.end <= type.end
            )
              continue;
            for (
              let ancestor: ts.Node | undefined = declaration.parent;
              ancestor;
              ancestor = ancestor.parent
            )
              if (ts.isBlock(ancestor) || ts.isModuleBlock(ancestor) || ts.isFunctionLike(ancestor))
                safe = false;
          }
        }
      }
      if (safe) ts.forEachChild(node, visit);
    };
    visit(type);
    return safe;
  });
}

function supported(fn: QueryFunction, checker: ts.TypeChecker, sf: ts.SourceFile) {
  const block = fn.body && ts.isBlock(fn.body) ? fn.body : undefined;
  if (
    !fn.body ||
    !canHoistParameterTypes(fn, checker) ||
    fn.type ||
    fn.typeParameters?.length ||
    ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.asteriskToken) ||
    fn.modifiers?.some((m) => m.kind !== ts.SyntaxKind.ExportKeyword) ||
    fn.parameters.some(
      (p) =>
        !ts.isIdentifier(p.name) ||
        p.name.getText(sf) === "this" ||
        p.dotDotDotToken ||
        p.modifiers?.length,
    )
  )
    return false;
  if (
    block &&
    (!block.statements.length ||
      !ts.isReturnStatement(block.statements.at(-1)!) ||
      block.statements
        .slice(0, -1)
        .some((s) => !ts.isVariableStatement(s) || !(s.declarationList.flags & ts.NodeFlags.Const)))
  )
    return false;
  if (ts.isFunctionDeclaration(fn))
    return !!fn.name && checker.getSymbolAtLocation(fn.name)?.declarations?.length === 1;
  const variable = fn.parent;
  return (
    ts.isVariableDeclaration(variable) &&
    !variable.type &&
    ts.isIdentifier(variable.name) &&
    !!(variable.parent.flags & ts.NodeFlags.Const)
  );
}

/** Specialize only a proven return path; other functions retain their union. */
export function specializeResult(
  prepared: ReturnType<typeof prepare>,
  q: ExtractedQuery,
  rows: readonly string[],
  cardinality = '"many"',
  queryError = 'import("reylo").PostgresQueryError',
): ResultSpecialization | undefined {
  if (new Set(rows).size < 2 || !prepared.statement || !prepared.checker) return;
  const sf = prepared.statement.getSourceFile(),
    checker = prepared.checker;
  const site = prepared.sites.find((s) => s.id === q.id);
  if (!site) return;
  let query: ts.TaggedTemplateExpression | undefined;
  const find = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n) && n.tag.getStart(sf) === site.start) query = n;
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!query) return;
  let ancestor: ts.Node | undefined = query.parent;
  while (ancestor && !ts.isFunctionLike(ancestor)) ancestor = ancestor.parent;
  if (
    !ancestor ||
    !(
      ts.isFunctionDeclaration(ancestor) ||
      ts.isArrowFunction(ancestor) ||
      ts.isFunctionExpression(ancestor)
    )
  )
    return;
  const fn = ancestor;
  if (!supported(fn, checker, sf) || returnedExpression(fn, checker) !== query) return;
  const block = fn.body && ts.isBlock(fn.body) ? fn.body : undefined;
  if (hasParameterWrites(fn, checker)) return;

  const prefix = prepared.prefix;
  const selected = new Map<ts.ParameterDeclaration, string>();
  const constantValue = (expression: ts.Expression): string | undefined => {
    const e = unwrap(expression);
    return (
      literal(e) ??
      (ts.isIdentifier(e) &&
      e.text === "undefined" &&
      !checker.getSymbolAtLocation(e)?.declarations?.length
        ? "undefined"
        : undefined)
    );
  };
  const primitive = (expression: ts.Expression, depth = 0): string | undefined => {
    if (depth > 16) return;
    const e = unwrap(expression),
      direct = literal(e);
    if (direct !== undefined) return direct;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const value = primitive(e.left, depth + 1),
        fallback = primitive(e.right, depth + 1);
      return value === undefined || fallback === undefined
        ? undefined
        : `${prefix}Coalesce<${value}, ${fallback}>`;
    }
    if (!ts.isIdentifier(e)) return;
    const declarations = checker.getSymbolAtLocation(e)?.declarations;
    if (e.text === "undefined" && !declarations?.length) return "undefined";
    if (declarations?.length !== 1) return;
    const declaration = declarations[0]!;
    if (ts.isParameter(declaration) && fn.parameters.includes(declaration)) {
      if (declaration.type && !primitiveType(declaration.type)) return;
      const type = parameterType(declaration, sf);
      if (!type) return;
      let selectedParameter = selected.get(declaration);
      if (!selectedParameter) {
        const generic = `${prefix}Args[${fn.parameters.indexOf(declaration)}]`;
        // Follow proven defaults (including earlier parameters); arbitrary defaults retain their full domain.
        const defaultType = declaration.initializer
          ? (primitive(declaration.initializer, depth + 1) ?? type)
          : undefined;
        selectedParameter =
          defaultType === undefined ? generic : `${prefix}Default<${generic}, ${defaultType}>`;
        selected.set(declaration, selectedParameter);
      }
      return selectedParameter;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      declaration.parent.flags & ts.NodeFlags.Const &&
      declaration.parent.parent.parent === block &&
      declaration.end < query!.getStart(sf)
    ) {
      return primitive(declaration.initializer, depth + 1);
    }
    return;
  };
  const truth = (expression: ts.Expression, depth = 0): string | undefined => {
    if (depth > 16) return;
    const e = unwrap(expression);
    const value = primitive(e);
    if (value !== undefined) return `${prefix}Truth<${value}>`;
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
      const inner = truth(e.operand, depth + 1);
      return inner === undefined ? undefined : `${prefix}Not<${inner}>`;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        const left = truth(e.left, depth + 1),
          right = truth(e.right, depth + 1);
        // Unknown terms are both possible, which still allows false && unknown.
        if (left === undefined && right === undefined) return;
        return `${prefix}${op === ts.SyntaxKind.AmpersandAmpersandToken ? "And" : "Or"}<${left ?? "boolean"}, ${right ?? "boolean"}>`;
      }
      const strict =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      const looseNull =
        (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) &&
        (unwrap(e.left).kind === ts.SyntaxKind.NullKeyword ||
          unwrap(e.right).kind === ts.SyntaxKind.NullKeyword);
      if (strict || looseNull) {
        let constant = constantValue(e.right),
          other = e.left;
        if (constant === undefined) {
          constant = constantValue(e.left);
          other = e.right;
        }
        if (constant === undefined) return;
        const type = primitive(other);
        if (type === undefined) return;
        const eq = `${prefix}Eq<${type}, ${looseNull ? "null | undefined" : constant}>`;
        return op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken
          ? `${prefix}Not<${eq}>`
          : eq;
      }
    }
    return;
  };
  const nodes = new Map<string, ts.Expression>();
  const index = (n: ts.Node) => {
    if (ts.isExpression(n)) nodes.set(`${n.getStart(sf)}:${n.end}`, n);
    ts.forEachChild(n, index);
  };
  index(sf);
  const proofValue = (p: BranchProof): string | undefined => {
    if (p.kind === "literal") return p.type;
    if (p.kind === "source") {
      const e = nodes.get(`${p.start}:${p.end}`);
      return e ? primitive(e) : undefined;
    }
    if (p.kind === "default") {
      const value = proofValue(p.value),
        fallback = proofValue(p.fallback);
      return value === undefined || fallback === undefined
        ? undefined
        : `${prefix}Default<${value}, ${fallback}>`;
    }
    if (p.kind === "binary" && p.op === "??") {
      const value = proofValue(p.left),
        fallback = proofValue(p.right);
      return value === undefined || fallback === undefined
        ? undefined
        : `${prefix}Coalesce<${value}, ${fallback}>`;
    }
    if (p.kind === "not" || (p.kind === "binary" && p.op !== "&&" && p.op !== "||"))
      return proofTruth(p);
    return;
  };
  const proofTruth = (p: BranchProof): string | undefined => {
    if (p.kind === "source") {
      const e = nodes.get(`${p.start}:${p.end}`);
      return e ? truth(e) : undefined;
    }
    if (p.kind === "literal" || p.kind === "default") {
      const value = proofValue(p);
      return value === undefined ? undefined : `${prefix}Truth<${value}>`;
    }
    if (p.kind === "not") {
      const value = proofTruth(p.value);
      return value === undefined ? undefined : `${prefix}Not<${value}>`;
    }
    if (p.kind === "binary") {
      if (p.op === "??") {
        const value = proofValue(p);
        return value === undefined ? undefined : `${prefix}Truth<${value}>`;
      }
      if (p.op === "&&" || p.op === "||") {
        const a = proofTruth(p.left),
          b = proofTruth(p.right);
        return a === undefined && b === undefined
          ? undefined
          : `${prefix}${p.op === "&&" ? "And" : "Or"}<${a ?? "boolean"}, ${b ?? "boolean"}>`;
      }
      const constant = (v: BranchProof) =>
        v.kind === "literal"
          ? v.type
          : v.kind === "source"
            ? (() => {
                const e = nodes.get(`${v.start}:${v.end}`);
                return e ? constantValue(e) : undefined;
              })()
            : undefined;
      let value = proofValue(p.left),
        c = constant(p.right);
      if (c === undefined) {
        value = proofValue(p.right);
        c = constant(p.left);
      }
      if (value === undefined || c === undefined) return;
      if ((p.op === "==" || p.op === "!=") && c !== "null") return;
      const eq = `${prefix}Eq<${value}, ${p.op === "==" || p.op === "!=" ? "null | undefined" : c}>`;
      return p.op === "!=" || p.op === "!==" ? `${prefix}Not<${eq}>` : eq;
    }
    return;
  };
  const rowTypes = rows.map((row, i) => {
    for (const guard of q.alternatives[i]?.guards ?? []) {
      if (guard.proof) {
        const condition = proofTruth(guard.proof);
        if (condition !== undefined)
          row = `${prefix}May<${condition}, ${guard.text.startsWith("truthy: ") ? "true" : "false"}, ${row}>`;
        continue;
      }
      if (guard.start === undefined || guard.end === undefined) continue;
      const expression = nodes.get(`${guard.start}:${guard.end}`);
      const expected = guard.text.startsWith("truthy: ")
        ? "true"
        : guard.text.startsWith("falsy: ")
          ? "false"
          : undefined;
      if (
        !expression ||
        expected === undefined ||
        expression.getText(sf) !== guard.text.slice(expected === "true" ? 8 : 7)
      )
        continue;
      const condition = truth(expression);
      if (condition !== undefined) row = `${prefix}May<${condition}, ${expected}, ${row}>`;
    }
    return row;
  });
  if (rowTypes.every((row, i) => row === rows[i])) return;
  const tuple = parameterTuple(fn, sf);
  if (!tuple) return;
  const rowAlias = `${prefix}Row_${q.id}`;
  return signatureEdits(
    fn,
    sf,
    prefix,
    q.id,
    tuple,
    rowAlias,
    [...new Set(rowTypes)].join(" | "),
    [...new Set(rows)].join(" | "),
    cardinality,
    queryError,
  );
}

function parameterTuple(fn: QueryFunction, sf: ts.SourceFile): string | undefined {
  const params: string[] = [];
  for (const [i, p] of fn.parameters.entries()) {
    const type = parameterType(p, sf);
    if (!type) return;
    const optional = !!(p.questionToken || p.initializer);
    const trailing = !fn.parameters.slice(i + 1).some((p) => !p.questionToken && !p.initializer);
    params.push(
      `${p.name.getText(sf)}${optional && trailing ? "?" : ""}: ${type}${optional ? " | undefined" : ""}`,
    );
  }
  return `[${params.join(", ")}]`;
}

function signatureEdits(
  fn: QueryFunction,
  sf: ts.SourceFile,
  prefix: string,
  id: string,
  tuple: string,
  rowAlias: string,
  row: string,
  broadRow: string,
  cardinality: string,
  queryError: string,
): ResultSpecialization {
  const declarations = [`type ${rowAlias}<${prefix}Args extends ${tuple}> = ${row};`];
  const generic = `const ${prefix}Args extends ${tuple}`;
  const result = `${prefix}Query<${rowAlias}<${prefix}Args>, ${cardinality}, ${queryError}>`;
  let edits: Edit[];
  if (ts.isFunctionDeclaration(fn)) {
    edits = [
      {
        start: fn.getStart(sf),
        end: fn.getStart(sf),
        text: `${fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? "export " : ""}function ${fn.name!.text}<${generic}>(...args: ${prefix}Args): ${result};\n`,
      },
    ];
  } else {
    // This checking-only identity validates the original implementation against
    // its broad SQL rows while exposing the proven conditional call signature.
    const identity = `${prefix}Specialize_${id}`;
    declarations.push(
      `declare function ${identity}(implementation: (...args: ${tuple}) => ${prefix}Query<${broadRow}, ${cardinality}, ${queryError}>): <${generic}>(...args: ${prefix}Args) => ${result};`,
    );
    edits = [
      { start: fn.getStart(sf), end: fn.getStart(sf), text: `${identity}(` },
      { start: fn.end, end: fn.end, text: ")" },
    ];
  }
  return { edits, declarations, fn, rowAlias, tuple, cardinality, queryError, depth: 0 };
}

export function hasParameterWrites(fn: QueryFunction, checker: ts.TypeChecker) {
  const parameterSymbols = new Set(fn.parameters.map((p) => checker.getSymbolAtLocation(p.name)));
  const touchesParameter = (n: ts.Node): boolean =>
    // A shorthand assignment's name has a property symbol; its value symbol is
    // the actual variable written by ({flag} = value), including nested patterns.
    (ts.isShorthandPropertyAssignment(n) &&
      parameterSymbols.has(checker.getShorthandAssignmentValueSymbol(n))) ||
    (ts.isIdentifier(n) && parameterSymbols.has(checker.getSymbolAtLocation(n))) ||
    !!ts.forEachChild(n, touchesParameter);
  return hasWrites(fn, touchesParameter);
}

/** Propagate proven local signatures through bounded, simple forwarding wrappers. */
export function specializeWrappers(
  prepared: ReturnType<typeof prepare>,
  roots: ResultSpecialization[],
): ResultSpecialization[] {
  if (!prepared.statement || !prepared.checker || !roots.length) return [];
  const sf = prepared.statement.getSourceFile(),
    checker = prepared.checker,
    prefix = prepared.prefix;
  const known = new Map(roots.map((s) => [s.fn, s]));
  const functions: QueryFunction[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      functions.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const output: ResultSpecialization[] = [];
  for (let pass = 0; pass < 16; pass++) {
    const before = output.length;
    for (const fn of functions) {
      if (known.has(fn) || !supported(fn, checker, sf) || hasParameterWrites(fn, checker)) continue;
      const expression = returnedExpression(fn, checker);
      if (
        !expression ||
        !ts.isCallExpression(expression) ||
        !ts.isIdentifier(expression.expression) ||
        expression.typeArguments?.length ||
        expression.arguments.some(ts.isSpreadElement)
      )
        continue;
      const d = checker.getSymbolAtLocation(expression.expression)?.valueDeclaration;
      const targetFn = d && ts.isVariableDeclaration(d) ? d.initializer : d;
      if (
        !targetFn ||
        !(
          ts.isFunctionDeclaration(targetFn) ||
          ts.isArrowFunction(targetFn) ||
          ts.isFunctionExpression(targetFn)
        )
      )
        continue;
      const target = known.get(targetFn);
      if (!target || target.depth >= 16) continue;
      const tuple = parameterTuple(fn, sf);
      if (!tuple) continue;
      const block = fn.body && ts.isBlock(fn.body) ? fn.body : undefined;
      const value = (e: ts.Expression, depth = 0): string | undefined => {
        if (depth > 16) return;
        e = unwrap(e);
        const l = literal(e);
        if (l !== undefined) return l;
        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
          const inner = value(e.operand, depth + 1);
          return inner === undefined ? undefined : `${prefix}Not<${prefix}Truth<${inner}>>`;
        }
        if (!ts.isIdentifier(e)) return;
        const d = checker.getSymbolAtLocation(e)?.valueDeclaration;
        if (e.text === "undefined" && !d) return "undefined";
        if (d && ts.isParameter(d) && fn.parameters.includes(d)) {
          const base = `${prefix}Args[${fn.parameters.indexOf(d)}]`;
          if (!d.initializer) return base;
          const fallback = value(d.initializer, depth + 1) ?? parameterType(d, sf);
          return fallback === undefined ? undefined : `${prefix}Default<${base}, ${fallback}>`;
        }
        if (
          d &&
          ts.isVariableDeclaration(d) &&
          d.initializer &&
          !d.type &&
          d.parent.flags & ts.NodeFlags.Const &&
          d.parent.parent.parent === block &&
          d.end < expression.getStart(sf)
        )
          return value(d.initializer, depth + 1);
        return;
      };
      const args = expression.arguments.map((a) => value(a));
      if (args.some((a) => a === undefined)) continue;
      const id = `wrapper${output.length}`,
        alias = `${prefix}Row_${id}`;
      const spec = signatureEdits(
        fn,
        sf,
        prefix,
        id,
        tuple,
        alias,
        `${target.rowAlias}<[${args.join(", ")}]>`,
        `${target.rowAlias}<${target.tuple}>`,
        target.cardinality,
        target.queryError,
      );
      spec.depth = target.depth + 1;
      known.set(fn, spec);
      output.push(spec);
    }
    if (output.length === before) break;
  }
  return output;
}

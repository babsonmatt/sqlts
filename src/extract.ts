import type { BranchProof } from "./branch-proof.ts";
import ts from "typescript-ast";
import { templateOffsets } from "./source-map.ts";
import { group, render, type Parts, type Clause } from "./parts.ts";

export interface BranchGuard {
  proof?: BranchProof;
  text: string;
  start?: number;
  end?: number;
}

export interface ExtractedQuery {
  id: string;
  file: string;
  line: number;
  variants: Parts[];
  /** UTF-16 source offsets for each character of the rendered named SQL. */
  sourceMaps: (number | undefined)[][];
  start: number;
  end: number;
  tagEnd: number;
  alternatives: { parts: Parts; conditions: readonly string[]; guards?: readonly BranchGuard[] }[];
}

// A deliberately small static language: direct tags/helpers, ternaries, and short-circuit helper operands.
// Application code is parsed, never imported or evaluated.
export function extract(
  source: string,
  file: string,
  budget = 64,
  tolerant = false,
  mergeEquivalentPaths = false,
  resolveValue?: (expression: string) => { expression: string; proof?: BranchProof } | undefined,
  maxMappedCharacters = Infinity,
): ExtractedQuery[] {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1024)
    throw new Error("Shape budget must be an integer between 1 and 1024");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = sf.statements.filter(ts.isImportDeclaration).flatMap((n) => {
    if (
      !ts.isStringLiteral(n.moduleSpecifier) ||
      !/(?:^|\/)\.inline\/sql(?:\.[jt]s)?$/.test(n.moduleSpecifier.text)
    )
      return [];
    const bindings = n.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings)
      ? bindings.elements
          .filter((e) => (e.propertyName ?? e.name).text === "sql")
          .map((e) => e.name.text)
      : [];
  });
  const names = new Set(imports);
  if (!names.size) return [];
  // Resolve identifier bindings with the compiler so a shadowing function argument
  // cannot be mistaken for the imported SQL tag.
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === file ? sf : undefined);
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const syntax = program.getSyntacticDiagnostics(sf);
  if (syntax.length && !tolerant)
    throw new Error(
      `${file}: ${syntax.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n")}`,
    );
  const isSql = (e: ts.Expression) =>
    ts.isIdentifier(e) &&
    names.has(e.text) &&
    checker.getSymbolAtLocation(e)?.declarations?.some(ts.isImportSpecifier);
  const fail = (n: ts.Node, message: string): never => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    throw new Error(`${file}:${line + 1}: ${message}`);
  };
  const unwrap = (e: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
  const method = (e: ts.Expression, name: string) =>
    ts.isPropertyAccessExpression(e) && isSql(e.expression) && e.name.text === name;
  const logicalAnd = (e: ts.Expression): e is ts.BinaryExpression =>
    ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
  const zero = (e: ts.Expression) =>
    (ts.isNumericLiteral(e) && Number(e.text) === 0) ||
    (ts.isBigIntLiteral(e) && BigInt(e.text.slice(0, -1)) === 0n);
  const absent = (e: ts.Expression) =>
    e.kind === ts.SyntaxKind.NullKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text === "") ||
    zero(e) ||
    (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && zero(e.operand)) ||
    (ts.isIdentifier(e) &&
      e.text === "undefined" &&
      !checker.getSymbolAtLocation(e)?.declarations?.length) ||
    method(e, "empty");
  const structural = (expression: ts.Expression): boolean => {
    const e = unwrap(expression);
    return (
      (ts.isTaggedTemplateExpression(e) && !!isSql(e.tag)) ||
      method(e, "empty") ||
      (ts.isCallExpression(e) && ["where", "and", "or"].some((m) => method(e.expression, m))) ||
      (ts.isConditionalExpression(e) && (structural(e.whenTrue) || structural(e.whenFalse))) ||
      (logicalAnd(e) && (structural(e.left) || structural(e.right)))
    );
  };
  const guard = (e: ts.Expression, truthy: boolean): BranchGuard => ({
    text: `${truthy ? "truthy" : "falsy"}: ${e.getText(sf)}`,
    start: e.getStart(sf),
    end: e.end,
  });
  const paths = new WeakMap<Parts, readonly BranchGuard[]>();
  const origins = new WeakMap<Parts, readonly (readonly number[] | undefined)[]>();
  const origin = (p: Parts) => origins.get(p) ?? p.map(() => undefined);
  const withPath = (
    parts: Parts,
    conditions: readonly BranchGuard[],
    source = origin(parts),
  ): Parts => {
    paths.set(parts, conditions);
    origins.set(parts, source);
    return parts;
  };
  const unique = (variants: Parts[], n: ts.Node): Parts[] => {
    const map = new Map<string, Parts>();
    for (const p of variants) {
      const key = JSON.stringify([
        render(p).named,
        p.filter((v) => typeof v !== "string").map((v) => [v.expression, v.proof]),
        mergeEquivalentPaths ? undefined : paths.get(p)?.map((g) => g.text),
      ]);
      const previous = map.get(key);
      if (previous && mergeEquivalentPaths) {
        const before = paths.get(previous) ?? [],
          after = paths.get(p) ?? [];
        if (JSON.stringify(before) !== JSON.stringify(after))
          paths.set(
            previous,
            before.length && after.length
              ? [
                  {
                    text: `either (${before.map((g) => g.text).join(" AND ")}) OR (${after.map((g) => g.text).join(" AND ")})`,
                  },
                ]
              : [],
          );
      } else map.set(key, p);
    }
    if (map.size > budget)
      fail(n, `More than ${budget} SQL shapes; split this query into smaller query sites`);
    return [...map.values()];
  };
  const cross = (a: Parts[], b: Parts[], n: ts.Node): Parts[] => {
    const out: Parts[] = [];
    for (const x of a)
      for (const y of b) {
        out.push(
          withPath(
            [...x, ...y],
            [...(paths.get(x) ?? []), ...(paths.get(y) ?? [])],
            [...origin(x), ...origin(y)],
          ),
        );
        if (out.length > budget * budget) fail(n, "SQL shape expansion budget exceeded");
      }
    return unique(out, n);
  };
  const value = (expression: ts.Expression, operand = false, helperOperand = false): Parts[] => {
    const e = unwrap(expression);
    if (absent(e) && (operand || method(e, "empty"))) return [[]];
    if (ts.isTaggedTemplateExpression(e) && isSql(e.tag)) return template(e.template);
    if (logicalAnd(e) && (operand || structural(e))) {
      // Outside a helper a falsy interpolation is a bound value, not an omitted
      // fragment. Require the helper so analysis and runtime cannot disagree.
      if (!helperOperand)
        fail(e, "Use conditional && fragments inside sql.where, sql.and, or sql.or");
      const condition = e.left;
      return unique(
        [
          ...value(e.right, true, true).map((p) =>
            withPath([...p], [guard(condition, true), ...(paths.get(p) ?? [])], origin(p)),
          ),
          withPath([], [guard(condition, false)]),
        ],
        e,
      );
    }
    if (ts.isConditionalExpression(e) && (operand || structural(e))) {
      const condition = e.condition;
      return unique(
        [
          ...value(e.whenTrue, true, helperOperand).map((p) =>
            withPath([...p], [guard(condition, true), ...(paths.get(p) ?? [])], origin(p)),
          ),
          ...value(e.whenFalse, true, helperOperand).map((p) =>
            withPath([...p], [guard(condition, false), ...(paths.get(p) ?? [])], origin(p)),
          ),
        ],
        e,
      );
    }
    if (ts.isCallExpression(e)) {
      const kind = (["where", "and", "or"] as const).find((m) => method(e.expression, m));
      if (kind) {
        let choices: Parts[][] = [[]];
        for (const arg of e.arguments) {
          const variants = value(arg, true, true);
          choices = choices.flatMap((before) => variants.map((p) => [...before, p]));
          if (choices.length > budget) fail(e, `More than ${budget} SQL shapes in ${kind}`);
        }
        return unique(
          choices.map((p) =>
            withPath(
              group(kind as Clause, p),
              p.flatMap((v) => paths.get(v) ?? []),
              (() => {
                const present = p.filter((v) =>
                  v.some((part) => typeof part !== "string" || part.trim()),
                );
                if (!present.length) return kind === "where" ? [] : [undefined];
                const mapped: (readonly number[] | undefined)[] = [undefined];
                present.forEach((v, i) => {
                  if (i) mapped.push(undefined);
                  mapped.push(undefined, ...origin(v), undefined);
                });
                if (kind !== "where") mapped.push(undefined);
                return mapped;
              })(),
            ),
          ),
          e,
        );
      }
    }
    if (operand)
      fail(
        e,
        "Expected a direct sql template/helper, sql.empty, or conditional fragment; fragment aliases and arbitrary helper functions are not analyzed yet",
      );
    return [
      withPath(
        [
          {
            value: undefined,
            ...(resolveValue?.(expression.getText(sf)) ?? { expression: e.getText(sf) }),
          },
        ],
        [],
        [[e.getStart(sf)]],
      ),
    ];
  };
  const literal = (node: ts.TemplateLiteralLikeNode): Parts => {
    const start = node.getStart(sf) + 1;
    const tail =
      node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle
        ? 2
        : node.isUnterminated
          ? 0
          : 1;
    return withPath(
      [node.text],
      [],
      [templateOffsets(source.slice(start, node.end - tail), start, node.text)],
    );
  };
  const template = (node: ts.TemplateLiteral): Parts[] => {
    if (ts.isNoSubstitutionTemplateLiteral(node)) return [literal(node)];
    let result: Parts[] = [literal(node.head)];
    for (const span of node.templateSpans)
      result = cross(result, cross(value(span.expression), [literal(span.literal)], span), span);
    return result;
  };
  const sourceMap = (parts: Parts): (number | undefined)[] => {
    let parameter = 0;
    return parts.flatMap((part, i) => {
      const points = origin(parts)[i];
      if (typeof part === "string")
        return Array.from({ length: part.length }, (_, j) => points?.[j]);
      return Array<number | undefined>(`:p${parameter++}`.length).fill(points?.[0]);
    });
  };
  const result: ExtractedQuery[] = [];
  let mappedCharacters = 0;
  const visit = (n: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(n) &&
      ts.isCallExpression(n.tag) &&
      method(n.tag.expression, "query")
    ) {
      try {
        const id = n.tag.arguments[0];
        if (n.tag.arguments.length !== 1 || !id || !ts.isStringLiteral(id))
          fail(n, "sql.query requires one literal query ID");
        const variants = template(n.template);
        const size = variants.reduce((n, parts) => n + render(parts).named.length, 0);
        if (mappedCharacters + size > maxMappedCharacters)
          fail(n, "SQL source-map budget exceeded; split large queries into smaller files");
        mappedCharacters += size;
        result.push({
          id: (id as ts.StringLiteral).text,
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          variants,
          sourceMaps: variants.map(sourceMap),
          start: n.getStart(sf),
          end: n.end,
          tagEnd: n.tag.end,
          alternatives: variants.map((parts) => ({
            parts,
            conditions: (paths.get(parts) ?? []).map((g) => g.text),
            guards: paths.get(parts) ?? [],
          })),
        });
      } catch (error) {
        if (!tolerant) throw error;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return result;
}

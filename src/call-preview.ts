import { returnedExpression, hasParameterWrites } from "./sqlts/result-types.ts";
import type { BranchProof } from "./branch-proof.ts";
import ts from "typescript-ast";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepare, mapOffset } from "./sqlts/transform.ts";
import { render } from "./parts.ts";
import { offset, position, type Position } from "./preview.ts";

type Primitive = string | number | boolean | bigint | null | undefined;
type Value = { known: true; value: Primitive } | { known: false; expression: string };
const known = (value: Primitive): Value => ({ known: true, value });
const unknown = (expression: string): Value => ({ known: false, expression });
type Env = Map<string, Value>;
const fence = (text: string, language: string) => {
  const marker = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${marker}${language}\n${text}\n${marker}`;
};
const format = (value: Primitive): string =>
  typeof value === "bigint"
    ? `${value}n`
    : value === undefined
      ? "undefined"
      : typeof value === "number" && !Number.isFinite(value)
        ? String(value)
        : JSON.stringify(value);

/** A small primitive interpreter, not eval: calls, getters, imports and application code never run. */
function evaluate(node: ts.Expression, env: Env, depth = 0, budget = { steps: 0 }): Value {
  const missing = () => unknown(node.getText());
  if (depth > 40 || ++budget.steps > 2000) return missing();
  const next = (n: ts.Expression) => evaluate(n, env, depth + 1, budget);
  if (ts.isParenthesizedExpression(node)) return next(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return known(node.text);
  if (ts.isNumericLiteral(node)) return known(Number(node.text));
  if (ts.isBigIntLiteral(node)) return known(BigInt(node.text.slice(0, -1)));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return known(true);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return known(false);
  if (node.kind === ts.SyntaxKind.NullKeyword) return known(null);
  if (ts.isIdentifier(node))
    return env.get(node.text) ?? (node.text === "undefined" ? known(undefined) : missing());
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const v = next(span.expression);
      if (!v.known) return missing();
      result += String(v.value) + span.literal.text;
    }
    return result.length <= 10000 ? known(result) : missing();
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const v = next(node.operand);
    if (!v.known) return missing();
    if (node.operator === ts.SyntaxKind.ExclamationToken) return known(!v.value);
    if (
      node.operator === ts.SyntaxKind.MinusToken &&
      (typeof v.value === "number" || typeof v.value === "bigint")
    )
      return known(-v.value);
    if (node.operator === ts.SyntaxKind.PlusToken && typeof v.value === "number") return v;
  }
  if (ts.isConditionalExpression(node)) {
    const c = next(node.condition);
    return c.known ? next(c.value ? node.whenTrue : node.whenFalse) : missing();
  }
  if (ts.isBinaryExpression(node)) {
    const a = next(node.left),
      op = node.operatorToken.kind;
    if (!a.known) return missing();
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return a.value ? next(node.right) : a;
    if (op === ts.SyntaxKind.BarBarToken) return a.value ? a : next(node.right);
    if (op === ts.SyntaxKind.QuestionQuestionToken) return a.value == null ? next(node.right) : a;
    const b = next(node.right);
    if (!b.known) return missing();
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return known(a.value === b.value);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return known(a.value !== b.value);
      // Loose null comparisons are useful presence checks; other coercive equality is left symbolic.
      case ts.SyntaxKind.EqualsEqualsToken:
        if (a.value == null || b.value == null) return known(a.value == null && b.value == null);
        break;
      case ts.SyntaxKind.ExclamationEqualsToken:
        if (a.value == null || b.value == null) return known(!(a.value == null && b.value == null));
        break;
      case ts.SyntaxKind.PlusToken:
        if (typeof a.value === "string" || typeof b.value === "string")
          return known(String(a.value) + String(b.value));
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value + b.value);
        break;
      case ts.SyntaxKind.MinusToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value - b.value);
        break;
      case ts.SyntaxKind.AsteriskToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value * b.value);
        break;
      case ts.SyntaxKind.GreaterThanToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value > b.value);
        break;
      case ts.SyntaxKind.GreaterThanEqualsToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value >= b.value);
        break;
      case ts.SyntaxKind.LessThanToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value < b.value);
        break;
      case ts.SyntaxKind.LessThanEqualsToken:
        if (typeof a.value === "number" && typeof b.value === "number")
          return known(a.value <= b.value);
        break;
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "length") {
    const v = next(node.expression);
    if (v.known && typeof v.value === "string") return known(v.value.length);
  }
  return missing();
}
const expression = (text: string, env: Env): Value => {
  const sf = ts.createSourceFile(
    "expression.ts",
    `(${text})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sf.statements[0];
  return statement && ts.isExpressionStatement(statement)
    ? evaluate(statement.expression, env)
    : unknown(text);
};

function evaluateProof(proof: BranchProof, source: string, env: Env, depth = 0): Value {
  if (depth > 32) return unknown("bounded helper condition");
  const next = (p: BranchProof) => evaluateProof(p, source, env, depth + 1);
  switch (proof.kind) {
    case "expression":
      return expression(
        proof.text,
        new Map(Object.entries(proof.bindings).map(([name, value]) => [name, next(value)])),
      );
    case "source":
      return expression(source.slice(proof.start, proof.end), env);
    case "literal":
      return expression(proof.type, new Map());
    case "unknown":
      return unknown("unproven shared value");
    case "default": {
      const v = next(proof.value);
      return v.known && v.value === undefined ? next(proof.fallback) : v;
    }
    case "not": {
      const v = next(proof.value);
      return v.known ? known(!v.value) : v;
    }
    case "binary": {
      const a = next(proof.left);
      if (!a.known) return a;
      if (proof.op === "&&") return a.value ? next(proof.right) : a;
      if (proof.op === "||") return a.value ? a : next(proof.right);
      if (proof.op === "??") return a.value == null ? next(proof.right) : a;
      const b = next(proof.right);
      return b.known
        ? expression(`${format(a.value)} ${proof.op} ${format(b.value)}`, new Map())
        : b;
    }
  }
}

export class CallPreviewService {
  private cache = new Map<string, { source: string; sf: ts.SourceFile; checker: ts.TypeChecker }>();
  private parse(file: string, source: string) {
    const cached = this.cache.get(file);
    if (cached?.source === source) return cached;
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
    const result = { source, sf, checker: program.getTypeChecker() };
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(file, result);
    return result;
  }
  close(uri: string) {
    try {
      this.cache.delete(fileURLToPath(uri));
    } catch {}
  }
  hover(uri: string, at: Position, documents: ReadonlyMap<string, string>) {
    const source = documents.get(uri);
    if (source === undefined || source.length > 500000 || !uri.startsWith("file:")) return null;
    const file = fileURLToPath(uri),
      current = this.parse(file, source),
      point = offset(source, at);
    let call: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        point >= node.expression.getStart() &&
        point < node.expression.end
      )
        call = node;
      ts.forEachChild(node, visit);
    };
    visit(current.sf);
    if (!call || !ts.isIdentifier(call.expression)) return null;
    const invocation: ts.CallExpression = call;
    const declaration = current.checker.getSymbolAtLocation(call.expression)?.declarations?.[0];
    let target = file,
      exported = call.expression.text;
    if (declaration && ts.isImportSpecifier(declaration)) {
      const m = declaration.parent.parent.parent.moduleSpecifier;
      if (!ts.isStringLiteral(m) || !m.text.startsWith(".") || !m.text.endsWith(".sqlts"))
        return null;
      target = resolve(dirname(file), m.text);
      exported = (declaration.propertyName ?? declaration.name).text;
    } else if (!file.endsWith(".sqlts")) return null;
    const read = (path: string) => {
      const opened = documents.get(pathToFileURL(path).href);
      if (opened !== undefined) return opened;
      if (statSync(path).size > 500000) throw Error("SQL preview source exceeds 500 KB");
      return readFileSync(path, "utf8");
    };
    const range = {
      start: position(source, invocation.expression.getStart()),
      end: position(source, invocation.expression.end),
    };
    try {
      const targetSource = read(target),
        module = this.parse(target, targetSource);
      let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
      if (target === file && declaration) {
        if (ts.isFunctionDeclaration(declaration)) fn = declaration;
        else if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        )
          fn = declaration.initializer;
      } else
        for (const s of module.sf.statements) {
          if (
            !ts.canHaveModifiers(s) ||
            !ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          )
            continue;
          if (ts.isFunctionDeclaration(s) && s.name?.text === exported) fn = s;
          if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const)
            for (const v of s.declarationList.declarations)
              if (
                ts.isIdentifier(v.name) &&
                v.name.text === exported &&
                v.initializer &&
                (ts.isArrowFunction(v.initializer) || ts.isFunctionExpression(v.initializer))
              )
                fn = v.initializer;
        }
      if (!fn?.body) return null;
      if (
        invocation.arguments.some(ts.isSpreadElement) ||
        fn.parameters.some((p) => !ts.isIdentifier(p.name) || p.dotDotDotToken)
      )
        throw Error("Spread/destructured arguments are not resolved by this preview");
      const resolvedBindings = new Map<ts.Declaration, Value>();
      let resolutions = 0;
      // Resolve only immutable primitive bindings. Function parameters remain unknown even with defaults.
      const resolveValue = (node: ts.Expression, seen = new Set<ts.Declaration>()): Value => {
        if (++resolutions > 256) return unknown(node.getText());
        const env: Env = new Map();
        const scan = (n: ts.Node) => {
          if (ts.isIdentifier(n)) {
            const d = current.checker.getSymbolAtLocation(n)?.declarations?.[0];
            if (
              d &&
              ts.isVariableDeclaration(d) &&
              d.parent.flags & ts.NodeFlags.Const &&
              d.initializer &&
              !seen.has(d) &&
              d.end < invocation.getStart()
            ) {
              const next = new Set(seen);
              next.add(d);
              let v = resolvedBindings.get(d);
              if (!v) {
                v = resolveValue(d.initializer, next);
                resolvedBindings.set(d, v);
              }
              env.set(n.text, v);
            } else if (d) env.set(n.text, unknown(n.text));
          }
          ts.forEachChild(n, scan);
        };
        scan(node);
        return evaluate(node, env);
      };
      const env: Env = new Map();
      fn.parameters.forEach((p, i) => {
        let v = invocation.arguments[i] ? resolveValue(invocation.arguments[i]!) : known(undefined);
        if (v.known && v.value === undefined && p.initializer) v = evaluate(p.initializer, env);
        env.set((p.name as ts.Identifier).text, v);
      });
      const prepared = prepare(targetSource, target, false, {
        readSource: read,
        mergeEquivalentPaths: false,
      });
      let query: (typeof prepared.queries)[number] | undefined;
      const visited = new Set<ts.Node>();
      for (let depth = 0; depth < 16 && fn?.body && !visited.has(fn); depth++) {
        visited.add(fn);
        if (hasParameterWrites(fn, module.checker))
          throw Error("Mutated parameters remain unresolved in SQL previews");
        if (ts.isBlock(fn.body!)) {
          if (
            !ts.isReturnStatement((fn.body as ts.Block).statements.at(-1)!) ||
            (fn.body as ts.Block).statements.some(
              (s) =>
                !ts.isReturnStatement(s) &&
                !(ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const),
            ) ||
            (fn.body as ts.Block).statements.filter(ts.isReturnStatement).length !== 1
          )
            throw Error(
              "This preview supports const bindings followed by one return; runtime control flow remains unresolved",
            );
          for (const s of (fn.body as ts.Block).statements)
            if (ts.isVariableStatement(s))
              for (const v of s.declarationList.declarations) {
                if (!ts.isIdentifier(v.name) || !v.initializer)
                  throw Error("Destructured local bindings remain unresolved");
                env.set(v.name.text, evaluate(v.initializer, env));
              }
        }
        const returned = returnedExpression(fn, module.checker);
        if (returned && ts.isTaggedTemplateExpression(returned)) {
          query = prepared.queries.find(
            (q) => mapOffset(prepared.analysis, q.start, true) === returned.getStart(),
          );
          break;
        }
        if (
          !returned ||
          !ts.isCallExpression(returned) ||
          !ts.isIdentifier(returned.expression) ||
          returned.arguments.some(ts.isSpreadElement)
        )
          break;
        const declaration = module.checker.getSymbolAtLocation(
          returned.expression,
        )?.valueDeclaration;
        const next =
          declaration && ts.isVariableDeclaration(declaration)
            ? declaration.initializer
            : declaration;
        if (
          !next ||
          !(
            ts.isFunctionDeclaration(next) ||
            ts.isArrowFunction(next) ||
            ts.isFunctionExpression(next)
          ) ||
          next.parameters.some((p) => !ts.isIdentifier(p.name) || p.dotDotDotToken)
        )
          break;
        const args = returned.arguments.map((arg) => evaluate(arg, env));
        env.clear();
        next.parameters.forEach((p, i) => {
          let value = args[i] ?? known(undefined);
          if (value.known && value.value === undefined && p.initializer)
            value = evaluate(p.initializer, env);
          env.set((p.name as ts.Identifier).text, value);
        });
        fn = next;
      }
      if (!query) throw Error("This call does not resolve to one supported SQL query");
      const matches = query.alternatives.filter((v) =>
        (v.guards ?? v.conditions.map((text) => ({ text }))).every((guard) => {
          const match = /^(truthy|falsy): ([\s\S]*)$/.exec(guard.text);
          if (!match) return true;
          const value =
            "proof" in guard && guard.proof
              ? evaluateProof(guard.proof, targetSource, env)
              : expression(match[2]!, env);
          return !value.known || Boolean(value.value) === (match[1] === "truthy");
        }),
      );
      if (!matches.length) throw Error("No SQL path could be resolved for these arguments");
      const exact = matches.length === 1;
      const header = `**SQL at this call**\n\n${exact ? "Resolved SQL structure: one path." : "Partially resolved: " + matches.length + " possible paths."} Known primitive arguments are resolved statically; application code is never executed.`;
      const blocks = matches.slice(0, 4).map((v, i) => {
        const sql = render(v.parts).text.trim();
        const values = v.parts.flatMap((p) =>
          typeof p === "string"
            ? []
            : [
                {
                  source: p.expression ?? "parameter",
                  value: p.proof
                    ? evaluateProof(p.proof, targetSource, env)
                    : expression(p.expression ?? "parameter", env),
                },
              ],
        );
        const bindings = values
          .map(
            (p, i) =>
              `$${i + 1} = ${p.value.known ? format(p.value.value) : `<${p.value.expression}> (runtime value)`}`,
          )
          .join("\n");
        return [
          exact ? "" : `**Possible path ${i + 1}**`,
          fence(sql, "sql"),
          bindings ? "**Bindings**\n\n" + fence(bindings, "text") : "No bindings.",
        ]
          .filter(Boolean)
          .join("\n\n");
      });
      const value = [
        header,
        ...blocks,
        matches.length > 4 ? `Showing 4 of ${matches.length} possible paths.` : "",
        "Values remain bound parameters; this preview does not inline them into SQL.",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (value.length > 24000) throw Error("Call preview exceeds its display budget");
      return { contents: { kind: "markdown", value }, range };
    } catch (error) {
      return {
        contents: {
          kind: "markdown",
          value:
            "**SQL call preview unavailable**\n\n" +
            fence(error instanceof Error ? error.message : String(error), "text"),
        },
        range,
      };
    }
  }
}

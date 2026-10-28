import { hasWrites } from "./mutations.ts";
import ts from "typescript-ast";
import type { BranchProof } from "../branch-proof.ts";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Context {
  file: string;
  sf: ts.SourceFile;
  checker: ts.TypeChecker;
}
type Binding = {
  node: ts.Expression;
  ctx: Context;
  env: Env;
  fallback?: Binding;
  missing?: boolean;
};
type Env = Map<ts.Declaration, Binding>;
export const sourceFingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
export interface FragmentExpansion {
  edits: { start: number; end: number; text: string }[];
  dependencies: string[];
  fingerprints: Record<string, string>;
  guards: Map<string, { text: string; proof: BranchProof }>;
  values: Map<string, { text: string; proof: BranchProof }>;
}

/** Resolve a bounded expression language. Never import/evaluate application modules. */
export function expandFragments(
  source: string,
  file: string,
  sqlName: string,
  readSource: (file: string) => string = (file) => readFileSync(file, "utf8"),
): FragmentExpansion {
  const contexts = new Map<string, Context>();
  const active = new Set<ts.Node>();
  const guards: FragmentExpansion["guards"] = new Map();
  const values: FragmentExpansion["values"] = new Map();
  const marker = randomUUID();
  let blockedProof = 0;
  let expansions = 0;
  const context = (file: string, source?: string): Context => {
    const cached = contexts.get(file);
    if (cached) return cached;
    if (contexts.size >= 64) throw Error("Shared fragments exceed 64 source files");
    source ??= readSource(file);
    if (source.length > 500_000) throw Error("Shared fragment files are limited to 500 KB");
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
    const ctx = { file, sf, checker: program.getTypeChecker() };
    contexts.set(file, ctx);
    return ctx;
  };
  const root = context(file, source);
  const decl = (node: ts.Node, ctx: Context) =>
    ctx.checker.getSymbolAtLocation(node)?.declarations?.[0];
  const isSql = (node: ts.Node, ctx: Context) => {
    const d = decl(node, ctx);
    if (!d || !ts.isImportSpecifier(d) || (d.propertyName ?? d.name).text !== "sql") return false;
    const m = d.parent.parent.parent.moduleSpecifier;
    return (
      ts.isStringLiteral(m) &&
      (m.text === "@sqlts/core" || /(?:^|\/)\.inline\/sql(?:\.[jt]s)?$/.test(m.text))
    );
  };
  const method = (node: ts.Node, ctx: Context, names: string[]) =>
    ts.isPropertyAccessExpression(node) &&
    isSql(node.expression, ctx) &&
    names.includes(node.name.text);
  const definition = (
    node: ts.Expression,
    ctx: Context,
  ): { node: ts.Declaration; ctx: Context } | undefined => {
    const d = decl(node, ctx);
    if (!d) return;
    if (!ts.isImportSpecifier(d)) return { node: d, ctx };
    const m = d.parent.parent.parent.moduleSpecifier;
    if (!ts.isStringLiteral(m) || !m.text.startsWith(".") || !m.text.endsWith(".sqlts")) return;
    const other = context(resolve(dirname(ctx.file), m.text));
    const name = (d.propertyName ?? d.name).text;
    for (const s of other.sf.statements) {
      if (
        !ts.canHaveModifiers(s) ||
        !ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        continue;
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return { node: s, ctx: other };
      if (ts.isVariableStatement(s))
        for (const v of s.declarationList.declarations)
          if (ts.isIdentifier(v.name) && v.name.text === name) return { node: v, ctx: other };
    }
  };
  const hasFragment = (node: ts.Node, ctx: Context, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (
      (ts.isTaggedTemplateExpression(node) &&
        (isSql(node.tag, ctx) || method(node.tag, ctx, ["fragment"]))) ||
      method(node, ctx, ["empty", "where", "and", "or"])
    )
      return true;
    if (ts.isIdentifier(node)) {
      const found = definition(node, ctx);
      if (found && found.node !== node && hasFragment(found.node, found.ctx, seen)) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && hasFragment(child, ctx, seen)) found = true;
    });
    return found;
  };
  const guarded = <T>(node: ts.Node, fn: () => T): T => {
    if (active.has(node)) throw Error("Recursive fragment definitions are not supported");
    if (active.size >= 32 || ++expansions > 2048)
      throw Error("Shared fragment expansion budget exceeded");
    active.add(node);
    try {
      const result = fn();
      if (typeof result === "string" && result.length > 500_000)
        throw Error("Expanded shared fragment exceeds 500 KB");
      return result;
    } finally {
      active.delete(node);
    }
  };
  const proof = (
    node: ts.Expression,
    ctx: Context,
    env: Env,
    depth = 0,
    budget = { steps: 0 },
  ): BranchProof => {
    if (depth > 24 || ++budget.steps > 2048 || blockedProof) return { kind: "unknown" };
    if (ts.isParenthesizedExpression(node))
      return proof(node.expression, ctx, env, depth + 1, budget);
    if (ts.isIdentifier(node)) {
      const d = decl(node, ctx),
        b = d && env.get(d);
      if (b) {
        if (b.missing) return { kind: "literal", type: "undefined" };
        const value = proof(b.node, b.ctx, b.env, depth + 1, budget);
        return b.fallback
          ? {
              kind: "default",
              value,
              fallback: proof(b.fallback.node, b.fallback.ctx, b.fallback.env, depth + 1, budget),
            }
          : value;
      }
    }
    // Source references retain lexical identity, never just an identifier's spelling.
    if (ctx === root && !env.size)
      return { kind: "source", start: node.getStart(ctx.sf), end: node.end };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return { kind: "literal", type: JSON.stringify(node.text) };
    if (ts.isNumericLiteral(node) && Number.isFinite(Number(node.text)))
      return { kind: "literal", type: String(Number(node.text)) };
    if (
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      )
    )
      return { kind: "literal", type: node.getText(ctx.sf) };
    if (ts.isIdentifier(node)) {
      const d = decl(node, ctx);
      if (node.text === "undefined" && !d) return { kind: "literal", type: "undefined" };
      if (d && ts.isVariableDeclaration(d) && d.initializer && d.parent.flags & ts.NodeFlags.Const)
        return proof(d.initializer, ctx, env, depth + 1, budget);
      return { kind: "unknown" };
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return { kind: "not", value: proof(node.operand, ctx, env, depth + 1, budget) };
    if (
      ts.isBinaryExpression(node) &&
      ["&&", "||", "??", "===", "!==", "==", "!="].includes(node.operatorToken.getText(ctx.sf))
    )
      return {
        kind: "binary",
        op: node.operatorToken.getText(ctx.sf),
        left: proof(node.left, ctx, env, depth + 1, budget),
        right: proof(node.right, ctx, env, depth + 1, budget),
      };
    if (
      ts.isTemplateExpression(node) ||
      ts.isConditionalExpression(node) ||
      ts.isPrefixUnaryExpression(node) ||
      ts.isBinaryExpression(node) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "length")
    ) {
      const bindings: Record<string, BranchProof> = Object.create(null);
      const visit = (child: ts.Node) => {
        if (ts.isIdentifier(child)) {
          bindings[child.text] ??= proof(child, ctx, env, depth + 1, budget);
          return;
        }
        if (ts.isPropertyAccessExpression(child)) {
          visit(child.expression);
          return;
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return { kind: "expression", text: node.getText(ctx.sf), bindings };
    }
    return { kind: "unknown" };
  };
  const guardText = (node: ts.Expression, ctx: Context, env: Env) => {
    const original = text(node, ctx, env);
    const expression = `(${original} /*sqlts:${marker}:${guards.size}*/)`;
    guards.set(expression, { text: original, proof: proof(node, ctx, env) });
    return expression;
  };
  const text = (node: ts.Expression, ctx: Context, env: Env, interpolation = false): string => {
    const replacement = fragment(node, ctx, env);
    if (replacement !== undefined) return replacement;
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (n: ts.Node) => {
      const d = ts.isIdentifier(n) ? decl(n, ctx) : undefined;
      const b = d && env.get(d);
      if (b) {
        edits.push({
          start: n.getStart(ctx.sf),
          end: n.end,
          text: b.missing
            ? "undefined"
            : b.fallback
              ? `((${text(b.node, b.ctx, b.env)}) === undefined ? (${text(b.fallback.node, b.fallback.ctx, b.fallback.env)}) : (${text(b.node, b.ctx, b.env)}))`
              : `(${text(b.node, b.ctx, b.env)})`,
        });
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    let result = node.getText(ctx.sf);
    for (const e of edits.reverse())
      result =
        result.slice(0, e.start - node.getStart(ctx.sf)) +
        e.text +
        result.slice(e.end - node.getStart(ctx.sf));
    if (interpolation) {
      const expression = `(${result} /*sqlts-value:${marker}:${values.size}*/)`;
      values.set(expression, { text: result, proof: proof(node, ctx, env) });
      return expression;
    }
    return result;
  };
  const fragment = (node: ts.Expression, ctx: Context, env: Env): string | undefined => {
    if (ts.isParenthesizedExpression(node)) {
      const f = fragment(node.expression, ctx, env);
      return f === undefined ? undefined : `(${f})`;
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      (isSql(node.tag, ctx) || method(node.tag, ctx, ["fragment"]))
    ) {
      // External modules must mark reusable pieces explicitly; bare sql there is a complete query.
      if (ctx !== root && isSql(node.tag, ctx)) {
        let current: ts.Node = node;
        while (
          current.parent &&
          (ts.isParenthesizedExpression(current.parent) ||
            ts.isConditionalExpression(current.parent) ||
            (ts.isBinaryExpression(current.parent) && current.parent.right === current))
        )
          current = current.parent;
        const parent = current.parent;
        const owner = parent && ts.isTemplateSpan(parent) ? parent.parent.parent : undefined;
        const nested =
          (parent &&
            ts.isCallExpression(parent) &&
            method(parent.expression, ctx, ["where", "and", "or"])) ||
          (owner &&
            ts.isTaggedTemplateExpression(owner) &&
            (isSql(owner.tag, ctx) || method(owner.tag, ctx, ["fragment"])));
        if (!nested) throw Error(`${ctx.file}: shared pieces must use sql.fragment`);
      }
      const edits: { start: number; end: number; text: string }[] = [];
      if (ts.isTemplateExpression(node.template))
        for (const span of node.template.templateSpans) {
          const replacement = text(span.expression, ctx, env, true);
          edits.push({
            start: span.expression.getStart(ctx.sf),
            end: span.expression.end,
            text: replacement,
          });
        }
      let result = node.template.getText(ctx.sf);
      for (const e of edits.reverse())
        result =
          result.slice(0, e.start - node.template.getStart(ctx.sf)) +
          e.text +
          result.slice(e.end - node.template.getStart(ctx.sf));
      return sqlName + result;
    }
    if (method(node, ctx, ["empty"])) return `${sqlName}.empty`;
    if (ts.isConditionalExpression(node)) {
      const a = fragment(node.whenTrue, ctx, env),
        b = fragment(node.whenFalse, ctx, env);
      if (a !== undefined || b !== undefined)
        return `(${guardText(node.condition, ctx, env)} ? ${a ?? text(node.whenTrue, ctx, env)} : ${b ?? text(node.whenFalse, ctx, env)})`;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const b = fragment(node.right, ctx, env);
      if (b !== undefined) return `(${guardText(node.left, ctx, env)} && ${b})`;
    }
    if (ts.isCallExpression(node) && method(node.expression, ctx, ["where", "and", "or"]))
      return `${sqlName}.${(node.expression as ts.PropertyAccessExpression).name.text}(${node.arguments.map((a) => text(a, ctx, env)).join(", ")})`;
    if (ts.isIdentifier(node)) {
      const d = decl(node, ctx),
        b = d && env.get(d);
      if (b) return guarded(node, () => fragment(b.node, b.ctx, b.env));
      const found = definition(node, ctx);
      if (found && ts.isVariableDeclaration(found.node) && found.node.initializer) {
        if (!(found.node.parent.flags & ts.NodeFlags.Const)) return;
        const { node: v, ctx: c } = found;
        return guarded(v, () => fragment(v.initializer!, c, env));
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const found = definition(node.expression, ctx);
      if (!found) return;
      let fn: ts.Node = found.node;
      if (ts.isVariableDeclaration(fn) && fn.initializer) {
        if (!(fn.parent.flags & ts.NodeFlags.Const)) return;
        fn = fn.initializer;
      }
      if (
        !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ||
        !fn.body
      )
        return;
      if (!hasFragment(fn.body, found.ctx)) return;
      if (node.arguments.some(ts.isSpreadElement))
        throw Error("Shared fragment calls require explicit value arguments");
      const body = fn.body;
      const statements = ts.isBlock(body) ? body.statements : undefined;
      const returned = statements
        ? statements.find(ts.isReturnStatement)?.expression
        : (body as ts.Expression);
      if (!returned) return;
      // Leave ordinary JavaScript value functions alone. Only SQL-returning helpers
      // are subject to the structural restrictions below.
      const unsupportedParameters = fn.parameters.some(
        (p) => !ts.isIdentifier(p.name) || p.dotDotDotToken,
      );
      const local = new Map<ts.Declaration, Binding>();
      fn.parameters.forEach((p, i) => {
        const argument = node.arguments[i];
        if (argument)
          local.set(p, {
            node: argument,
            ctx,
            env,
            fallback: p.initializer
              ? { node: p.initializer, ctx: found.ctx, env: new Map(local) }
              : undefined,
          });
        else if (p.initializer)
          local.set(p, { node: p.initializer, ctx: found.ctx, env: new Map(local) });
        else
          local.set(p, {
            node: p.name as ts.Identifier,
            ctx: found.ctx,
            env: new Map(local),
            missing: true,
          });
      });
      for (const s of statements ?? [])
        if (ts.isVariableStatement(s))
          for (const v of s.declarationList.declarations) {
            if (!ts.isIdentifier(v.name) || !v.initializer)
              throw Error("Shared fragments require initialized const bindings");
            local.set(v, { node: v.initializer, ctx: found.ctx, env: new Map(local) });
          }
      return guarded(fn, () => {
        const unsafe = hasWrites(fn);
        if (unsafe) blockedProof++;
        let result: string | undefined;
        try {
          result = fragment(returned, found.ctx, local);
        } finally {
          if (unsafe) blockedProof--;
        }
        if (result === undefined) return;
        if (unsupportedParameters) throw Error("Shared fragments require simple value parameters");
        if (
          statements &&
          (statements.filter(ts.isReturnStatement).length !== 1 ||
            !ts.isReturnStatement(statements.at(-1)!) ||
            statements.some(
              (s) =>
                !ts.isReturnStatement(s) &&
                !(ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const),
            ))
        )
          throw Error(
            `${found.ctx.file}: shared fragment functions require const declarations followed by one return`,
          );
        return result;
      });
    }
    return undefined;
  };
  const edits: FragmentExpansion["edits"] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isCallExpression(node.tag) &&
      method(node.tag.expression, root, ["query"])
    ) {
      if (ts.isTemplateExpression(node.template))
        for (const span of node.template.templateSpans) {
          // Only replace expressions which actually refer to shared definitions. Direct templates keep exact mappings.
          const find = (n: ts.Node) => {
            if (
              ts.isExpression(n) &&
              (ts.isIdentifier(n) ||
                (ts.isCallExpression(n) && !method(n.expression, root, ["where", "and", "or"])))
            ) {
              const f = fragment(n, root, new Map());
              if (f !== undefined) {
                edits.push({ start: n.getStart(root.sf), end: n.end, text: f });
                return;
              }
            }
            ts.forEachChild(n, find);
          };
          find(span.expression);
        }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root.sf);
  if (edits.reduce((n, e) => n + e.text.length, 0) > 1_000_000)
    throw Error("Expanded shared fragments exceed 1 MB per file");
  return {
    edits,
    guards,
    values,
    dependencies: [...contexts.keys()].filter((f) => f !== file),
    fingerprints: Object.fromEntries(
      [...contexts].filter(([f]) => f !== file).map(([f, c]) => [f, sourceFingerprint(c.sf.text)]),
    ),
  };
}

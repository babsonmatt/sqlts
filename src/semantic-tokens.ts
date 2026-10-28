import ts from "typescript-ast";
import { templateOffsets } from "./source-map.ts";
import { lex } from "./sql-lex.ts";
import { position } from "./preview.ts";
export const tokenTypes = [
  "keyword",
  "type",
  "function",
  "property",
  "number",
  "string",
  "comment",
  "operator",
  "namespace",
];
const keywords = new Set(
  "select from where and or not as on join inner outer left right full cross lateral with recursive materialized distinct all union intersect except order by asc desc nulls first last group having window over partition rows range groups between unbounded preceding following current row filter within limit offset fetch next only for update insert into values delete returning conflict do nothing default set merge using when matched then source target case else end is null true false exists in like ilike similar to escape any some array variadic ordinality cast collate at time zone".split(
    " ",
  ),
);
const types = new Set(
  "int integer int2 int4 int8 bigint smallint text varchar numeric decimal real float4 float8 double precision boolean bool json jsonb date timestamp timestamptz interval uuid bytea record".split(
    " ",
  ),
);
/** Lex the authored templates independently of query validation and fragment resolution. */
function sqlTemplates(source: string, file: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = (name) => (name === file ? sf : undefined);
  const checker = ts.createProgram([file], { noLib: true, noResolve: true }, host).getTypeChecker();
  const bindings = new Set<ts.ImportSpecifier>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const module = statement.moduleSpecifier.text;
    if (module !== "reylo-sqlts-experiment" && !/(?:^|\/)\.inline\/sql(?:\.[jt]s)?$/.test(module))
      continue;
    const imports = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly || !imports || !ts.isNamedImports(imports)) continue;
    for (const specifier of imports.elements)
      if (!specifier.isTypeOnly && (specifier.propertyName ?? specifier.name).text === "sql")
        bindings.add(specifier);
  }
  const isSql = (node: ts.Node) =>
    ts.isIdentifier(node) &&
    checker
      .getSymbolAtLocation(node)
      ?.declarations?.some((d) => ts.isImportSpecifier(d) && bindings.has(d));
  const method = (node: ts.Node, name: string) =>
    ts.isPropertyAccessExpression(node) && isSql(node.expression) && node.name.text === name;
  const result: { sql: string; map: (number | undefined)[] }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      (isSql(node.tag) ||
        method(node.tag, "fragment") ||
        (ts.isCallExpression(node.tag) && method(node.tag.expression, "query")))
    ) {
      let sql = "";
      const map: (number | undefined)[] = [];
      const literal = (part: ts.TemplateLiteralLikeNode) => {
        const start = part.getStart(sf) + 1;
        const suffix =
          part.kind === ts.SyntaxKind.TemplateHead || part.kind === ts.SyntaxKind.TemplateMiddle
            ? 2
            : part.isUnterminated
              ? 0
              : 1;
        sql += part.text;
        for (const point of templateOffsets(
          source.slice(start, part.end - suffix),
          start,
          part.text,
        ))
          map.push(point);
      };
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) literal(node.template);
      else {
        literal(node.template.head);
        for (const [i, span] of node.template.templateSpans.entries()) {
          const placeholder = `:__sql_color_${i}`;
          sql += placeholder;
          map.push(...Array<undefined>(placeholder.length).fill(undefined));
          literal(span.literal);
        }
      }
      result.push({ sql, map });
    }
    // Nested fragments get their own SQL ranges. The enclosing hole never colors JavaScript.
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

/** Color only authored SQL characters. Interpolated JavaScript keeps its TS tokens. */
export class SqlSemanticTokens {
  private cache = new Map<string, { source: string; data: number[] }>();
  close(file: string) {
    this.cache.delete(file);
  }
  full(source: string, file: string) {
    const cached = this.cache.get(file);
    if (cached?.source === source) return { data: cached.data };
    const spans = new Map<number, { start: number; end: number; type: number }>();
    if (source.length > 500_000) return { data: [] };
    for (const { sql, map } of sqlTemplates(source, file)) {
      const tokens = lex(sql);
      for (const [i, token] of tokens.entries()) {
        const start = map[token.start],
          last = map[token.end - 1];
        if (start === undefined || last === undefined) continue;
        // A generated placeholder maps every character to the JS expression.
        if (
          Array.from({ length: token.end - token.start }, (_, j) => map[token.start + j]).some(
            (n, j) => n !== start + j,
          )
        )
          continue;
        // Single placeholder punctuation/digits are not authored either.
        if (source.slice(start, last + 1) !== token.text) continue;
        const type =
          token.kind === "hidden"
            ? /^(--|\/\*)/.test(token.text)
              ? "comment"
              : "string"
            : token.kind === "id"
              ? keywords.has(token.name) && !token.text.startsWith('"')
                ? "keyword"
                : types.has(token.name) && !token.text.startsWith('"')
                  ? "type"
                  : tokens[i + 1]?.text === "("
                    ? "function"
                    : tokens[i + 1]?.text === "."
                      ? "namespace"
                      : "property"
              : /^\d$/.test(token.text)
                ? "number"
                : "operator";
        let at = start;
        for (const line of source.slice(start, last + 1).split("\n")) {
          const length = line.replace(/\r$/, "").length;
          if (length)
            spans.set(at, { start: at, end: at + length, type: tokenTypes.indexOf(type) });
          at += line.length + 1;
        }
      }
    }
    const data: number[] = [];
    let lastLine = 0,
      lastChar = 0,
      end = 0;
    for (const span of [...spans.values()].sort((a, b) => a.start - b.start)) {
      if (span.start < end) continue;
      const p = position(source, span.start);
      data.push(
        p.line - lastLine,
        p.line === lastLine ? p.character - lastChar : p.character,
        span.end - span.start,
        span.type,
        0,
      );
      lastLine = p.line;
      lastChar = p.character;
      end = span.end;
    }
    if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(file, { source, data });
    return { data };
  }
}

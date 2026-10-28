export interface Token {
  text: string;
  name: string;
  start: number;
  end: number;
  depth: number;
  kind: "id" | "symbol" | "hidden";
}
// Tolerant lexical context: incomplete SQL is expected while a user types.
export function lex(sql: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    if (/\s/.test(sql[i]!)) {
      i++;
      continue;
    }
    const start = i;
    let kind: Token["kind"] = "symbol";
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
      kind = "hidden";
    } else if (sql.startsWith("/*", i)) {
      i += 2;
      let nesting = 1;
      while (i < sql.length && nesting) {
        if (sql.startsWith("/*", i)) {
          nesting++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          nesting--;
          i += 2;
        } else i++;
      }
      kind = "hidden";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      kind = quote === '"' ? "id" : "hidden";
      while (i < sql.length) {
        if (sql[i] === "\\" && quote === "'" && /[eE]/.test(sql[start - 1] ?? "")) {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) i++;
          else break;
        }
      }
    } else {
      const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
      if (dollar) {
        const end = sql.indexOf(dollar, i + dollar.length);
        i = end < 0 ? sql.length : end + dollar.length;
        kind = "hidden";
      } else {
        const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(i))?.[0];
        if (word) {
          i += word.length;
          kind = "id";
        } else i++;
      }
    }
    const text = sql.slice(start, i);
    if (text === ")") depth = Math.max(0, depth - 1);
    out.push({
      text,
      name: text.startsWith('"')
        ? text
            .slice(1, text.endsWith('"') && text.length > 1 ? -1 : undefined)
            .replaceAll('""', '"')
        : text.toLowerCase(),
      start,
      end: i,
      depth,
      kind,
    });
    if (text === "(") depth++;
  }
  return out;
}
export const keyword = (t: Token | undefined, word: string) =>
  t?.kind === "id" && !t.text.startsWith('"') && t.name === word;

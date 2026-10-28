export interface Token {
  kind: "code" | "comment" | "quoted";
  text: string;
  start: number;
}

// Preserve literals/identifiers/comments byte-for-byte. Only code tokens may contain placeholders
// or directives. PostgreSQL supports nested block comments, doubled quotes and dollar strings.
export function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  let codeStart = 0;
  while (i < sql.length) {
    const start = i;
    let kind: Token["kind"] = "quoted";
    if (sql.startsWith("--", i)) {
      kind = "comment";
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", i)) {
      kind = "comment";
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment");
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      const escaped =
        quote === "'" && /[eE]/.test(sql[start - 1] ?? "") && !/[\w$]/.test(sql[start - 2] ?? "");
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === quote) {
          if (sql[i] === quote) {
            i++;
            continue;
          }
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated SQL quote");
    } else {
      // A dollar sign within an unquoted identifier does not start a string.
      const delimiter = /[\w$\u0080-\uffff]/.test(sql[i - 1] ?? "")
        ? undefined
        : /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)?\$/.exec(sql.slice(i))?.[0];
      if (!delimiter) {
        i++;
        continue;
      }
      const end = sql.indexOf(delimiter, i + delimiter.length);
      if (end < 0) throw new Error("Unterminated SQL dollar quote");
      i = end + delimiter.length;
    }
    if (start > codeStart)
      result.push({ kind: "code", text: sql.slice(codeStart, start), start: codeStart });
    result.push({ kind, text: sql.slice(start, i), start });
    codeStart = i;
  }
  if (codeStart < sql.length)
    result.push({ kind: "code", text: sql.slice(codeStart), start: codeStart });
  return result;
}

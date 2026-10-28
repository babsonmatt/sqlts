import { SqlSemanticTokens, tokenTypes } from "../semantic-tokens.ts";

/** Syntax coloring never resolves imports, enumerates query shapes or accesses the database. */
export class SqltsSemanticTokens {
  private readonly colors = new SqlSemanticTokens();
  close(file: string) {
    this.colors.close(file + ".ts");
  }
  full(source: string, file: string): { data: number[] } {
    if (source.length > 500_000 || !file.endsWith(".sqlts")) {
      this.close(file);
      return { data: [] };
    }
    return this.colors.full(source, file + ".ts");
  }
}
export { tokenTypes };

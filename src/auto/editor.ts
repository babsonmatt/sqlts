import ts from "typescript-ast";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { codeRoot, defaultProject, removeAuto, type Snapshot, type AutoError } from "./project.ts";
import { generatedPosition, mapOffset, originalRange, transformAuto } from "./transform.ts";
import { PreviewService, offset, position, type Position, type Range } from "../preview.ts";
import { CompletionService } from "../completion.ts";
import { CatalogService } from "../catalog-service.ts";
import { SqlSemanticTokens, tokenTypes } from "../semantic-tokens.ts";

export interface EditorDiagnostic {
  range: Range;
  severity: number;
  source: string;
  message: string;
  code?: number;
}
interface State {
  snapshot: Snapshot;
  language: ts.LanguageService;
}
export class AutoEditor {
  readonly documents = new Map<string, string>();
  private revision = 0;
  private attempted = -1;
  private task?: Promise<void>;
  private child?: ReturnType<typeof Bun.spawn>;
  private timer?: ReturnType<typeof setTimeout>;
  private state?: State;
  private stopped = false;
  private readonly session: string;
  private preview = new PreviewService();
  private completion = new CompletionService();
  private colors = new SqlSemanticTokens();
  private catalog = new CatalogService(() => {}, { projectRoot: codeRoot });
  constructor(
    readonly root = defaultProject,
    private readonly publish: (file: string, diagnostics: EditorDiagnostic[]) => void = () => {},
  ) {
    this.session = resolve(root, ".auto", "editor-" + crypto.randomUUID());
  }
  accepts(file: string) {
    const path = relative(this.root, file);
    return (
      !isAbsolute(path) &&
      !path.startsWith("..") &&
      !path.split("/").some((p) => p.startsWith(".")) &&
      path.endsWith(".ts") &&
      path !== "sql.ts"
    );
  }
  update(file: string, text: string) {
    if (
      !this.accepts(file) ||
      text.length > 500_000 ||
      (!this.documents.has(file) && this.documents.size >= 64)
    )
      return;
    this.documents.set(file, text);
    this.invalidate();
    this.publish(file, []);
    this.timer = setTimeout(() => void this.ready(), 250);
  }
  close(file: string) {
    this.documents.delete(file);
    this.publish(file, []);
    this.invalidate();
  }
  private invalidate() {
    this.revision++;
    clearTimeout(this.timer);
    this.child?.kill();
  }
  async ready() {
    clearTimeout(this.timer);
    while (!this.stopped && this.attempted !== this.revision) {
      if (!this.task)
        this.task = this.rebuild(this.revision).finally(() => {
          this.task = undefined;
        });
      await this.task;
    }
  }
  private async rebuild(revision: number) {
    const snapshotParent = resolve(this.session, String(revision));
    let next: Snapshot | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          `--config=${resolve(codeRoot, "editors/zed/server.bunfig.toml")}`,
          resolve(codeRoot, "scripts/auto-worker.ts"),
        ],
        {
          cwd: codeRoot,
          stdin: new Blob([
            JSON.stringify({
              root: this.root,
              documents: Object.fromEntries(this.documents),
              snapshotParent,
            }),
          ]),
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      this.child = child;
      timer = setTimeout(() => child.kill(), 20_000);
      const output = await new Response(child.stdout).text();
      await child.exited;
      const result = output.split("\n").findLast((l) => l.startsWith("AUTO_RESULT:"));
      if (!result)
        throw Error("Auto generation failed or timed out. Run bun run auto:check for details.");
      const data = JSON.parse(result.slice("AUTO_RESULT:".length)) as {
        snapshot?: Snapshot;
        errors?: AutoError[];
        message?: string;
      };
      next = data.snapshot;
      if (this.stopped || revision !== this.revision) {
        if (next) await removeAuto(next);
        return;
      }
      this.attempted = revision;
      if (!next) {
        if (this.state) {
          this.state.language.dispose();
          await removeAuto(this.state.snapshot);
          this.state = undefined;
        }
        for (const file of this.documents.keys())
          this.publish(
            file,
            (data.errors ?? []).filter((e) => e.file === file).map((e) => e.diagnostic),
          );
        if (!data.errors?.length)
          for (const file of this.documents.keys())
            this.publish(file, [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                severity: 1,
                source: "reylo-auto",
                message: data.message ?? "Auto generation failed",
              },
            ]);
        return;
      }
      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: true,
        types: ["bun"],
      };
      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => options,
        getScriptFileNames: () => [...next!.files.map((f) => f.shadow), next!.artifact],
        getScriptVersion: () => String(revision),
        getScriptSnapshot: (file) => {
          try {
            return ts.ScriptSnapshot.fromString(readFileSync(file, "utf8"));
          } catch {
            return undefined;
          }
        },
        getCurrentDirectory: () => codeRoot,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: (...args) => ts.sys.fileExists(...args),
        readFile: (...args) => ts.sys.readFile(...args),
        readDirectory: (...args) => ts.sys.readDirectory(...args),
        directoryExists: (...args) => ts.sys.directoryExists(...args),
        getDirectories: (...args) => ts.sys.getDirectories(...args),
      };
      const language = ts.createLanguageService(host);
      if (this.state) {
        this.state.language.dispose();
        await removeAuto(this.state.snapshot);
      }
      this.state = { snapshot: next, language };
      for (const file of next.files) {
        const errors = [
          ...language.getSyntacticDiagnostics(file.shadow),
          ...language.getSemanticDiagnostics(file.shadow),
        ];
        this.publish(
          file.original,
          errors.map((d) => ({
            range: originalRange(file, {
              start: position(file.text, d.start ?? 0),
              end: position(file.text, (d.start ?? 0) + (d.length ?? 1)),
            }),
            severity: d.category === ts.DiagnosticCategory.Error ? 1 : 2,
            source: "reylo-auto",
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          })),
        );
      }
    } catch (error) {
      if (revision === this.revision && !this.stopped) {
        this.attempted = revision;
        if (this.state) {
          this.state.language.dispose();
          await removeAuto(this.state.snapshot);
          this.state = undefined;
        }
        for (const file of this.documents.keys())
          this.publish(file, [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              severity: 1,
              source: "reylo-auto",
              message: String(error),
            },
          ]);
      }
    } finally {
      clearTimeout(timer);
      this.child = undefined;
      if (!next || this.state?.snapshot !== next)
        await rm(snapshotParent, { recursive: true, force: true });
    }
  }
  private async context(file: string, at: Position) {
    await this.ready();
    if (this.attempted !== this.revision || !this.state) return;
    const entry = this.state.snapshot.files.find((f) => f.original === file);
    if (!entry) return;
    const generated = generatedPosition(entry, at);
    return {
      file: entry,
      at: generated,
      cursor: offset(entry.text, generated),
      language: this.state.language,
    };
  }
  private source(file: string) {
    if (!this.accepts(file)) return;
    try {
      return transformAuto(
        this.documents.get(file) ?? readFileSync(file, "utf8"),
        file,
        resolve(this.session, "preview", relative(this.root, file)),
        this.root,
        resolve(this.session, "preview/.inline/sql.ts"),
      );
    } catch {
      return;
    }
  }
  async hover(file: string, at: Position) {
    const source = this.source(file);
    if (source) {
      this.preview.documents.set(source.shadow, source.text);
      const sql = this.preview.hover(source.shadow, generatedPosition(source, at));
      if (sql)
        return {
          ...sql,
          contents: {
            ...sql.contents,
            value: sql.contents.value
              .replace(/Inline SQL: auto_[a-f0-9]+/, "Inline SQL: automatic query")
              .replace("bun run typecheck", "bun run auto:check"),
          },
          ...(sql.range ? { range: originalRange(source, sql.range) } : {}),
        };
    }
    const context = await this.context(file, at);
    if (!context) return null;
    const { file: f, cursor, language } = context;
    const info = language.getQuickInfoAtPosition(f.shadow, cursor);
    if (!info) return null;
    return {
      contents: {
        kind: "markdown",
        value: "```typescript\n" + ts.displayPartsToString(info.displayParts) + "\n```",
      },
      range: originalRange(f, {
        start: position(f.text, info.textSpan.start),
        end: position(f.text, info.textSpan.start + info.textSpan.length),
      }),
    };
  }
  async complete(file: string, at: Position) {
    const source = this.source(file);
    const revision = this.revision;
    if (source) {
      const sql = this.completion.complete(
        source.text,
        source.shadow,
        generatedPosition(source, at),
        await this.catalog.get(),
      );
      if (revision !== this.revision) return { items: [], isIncomplete: true };
      if (sql.items.length)
        return {
          ...sql,
          items: sql.items.map((item) => ({
            ...item,
            textEdit: { ...item.textEdit, range: originalRange(source, item.textEdit.range) },
          })),
        };
    }
    const context = await this.context(file, at);
    if (!context) return { items: [], isIncomplete: true };
    const { file: f, language, cursor } = context;
    const result = language.getCompletionsAtPosition(f.shadow, cursor, {});
    return {
      isIncomplete: (result?.entries.length ?? 0) > 200,
      items: (result?.entries ?? []).slice(0, 200).map((e) => {
        const details = language.getCompletionEntryDetails(
          f.shadow,
          cursor,
          e.name,
          {},
          e.source,
          {},
          e.data,
        );
        const span = e.replacementSpan ?? { start: cursor, length: 0 };
        return {
          label: e.name,
          kind: e.kind === ts.ScriptElementKind.memberVariableElement ? 5 : 6,
          detail: ts.displayPartsToString(details?.displayParts),
          textEdit: {
            range: originalRange(f, {
              start: position(f.text, span.start),
              end: position(f.text, span.start + span.length),
            }),
            newText: e.insertText ?? e.name,
          },
        };
      }),
    };
  }
  async definition(file: string, at: Position) {
    const context = await this.context(file, at);
    if (!context) return null;
    return (context.language.getDefinitionAtPosition(context.file.shadow, context.cursor) ?? [])
      .map((d) => {
        const target = this.state!.snapshot.files.find((f) => f.shadow === d.fileName);
        if (!target) return null;
        return {
          file: target.original,
          range: originalRange(target, {
            start: position(target.text, d.textSpan.start),
            end: position(target.text, d.textSpan.start + d.textSpan.length),
          }),
        };
      })
      .filter((d) => d !== null);
  }
  async semantic(file: string) {
    const source = this.source(file);
    if (!source) return { data: [] };
    const f = source,
      tokens = this.colors.full(f.text, f.shadow).data,
      data: number[] = [];
    let line = 0,
      char = 0,
      lastLine = 0,
      lastChar = 0;
    for (let i = 0; i < tokens.length; i += 5) {
      line += tokens[i]!;
      char = tokens[i] === 0 ? char + tokens[i + 1]! : tokens[i + 1]!;
      const start = offset(f.text, { line, character: char }),
        end = start + tokens[i + 2]!;
      const a = mapOffset(f, start, true),
        b = mapOffset(f, end, true),
        p = position(f.source, a);
      if (b <= a || f.source.slice(a, b) !== f.text.slice(start, end)) continue;
      data.push(
        p.line - lastLine,
        p.line === lastLine ? p.character - lastChar : p.character,
        b - a,
        tokens[i + 3]!,
        0,
      );
      lastLine = p.line;
      lastChar = p.character;
    }
    return { data };
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill();
    await this.task;
    this.catalog.stop();
    await rm(this.session, { recursive: true, force: true });
    if (this.state) {
      this.state.language.dispose();
      await removeAuto(this.state.snapshot);
      this.state = undefined;
    }
  }
}
export { tokenTypes };

import { resolve } from "node:path";
export function client(
  command: string[],
  env: Record<string, string | undefined> = {},
  onNotification?: (method: string, params: unknown) => void,
  onServerRequest?: (method: string, params: unknown) => void,
  cwd = resolve("."),
) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: "postgres://preview-must-not-connect.invalid/test",
      ...env,
    },
  });
  let id = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let stderr = "";
  void new Response(child.stderr).text().then((text) => {
    stderr = text;
  });
  void child.exited.then((code) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`LSP exited (${code}): ${stderr}`));
    }
    pending.clear();
  });
  void (async () => {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      for (;;) {
        const sep = buffer.indexOf("\r\n\r\n");
        if (sep < 0) break;
        const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, sep).toString())?.[1];
        if (!length) throw new Error("Invalid LSP response header");
        const end = sep + 4 + Number(length);
        if (buffer.length < end) break;
        const response = JSON.parse(buffer.subarray(sep + 4, end).toString()) as {
          id?: number;
          result?: unknown;
          error?: unknown;
          method?: string;
          params?: { items?: unknown[] };
        };
        buffer = buffer.subarray(end);
        if (response.id !== undefined && response.method) {
          onServerRequest?.(response.method, response.params);
          send({
            jsonrpc: "2.0",
            id: response.id,
            result:
              response.method === "workspace/configuration"
                ? (response.params?.items ?? []).map(() => null)
                : null,
          });
          continue;
        }
        if (response.id === undefined && response.method)
          onNotification?.(response.method, response.params);
        const waiting = response.id === undefined ? undefined : pending.get(response.id);
        if (waiting && !response.method) {
          clearTimeout(waiting.timer);
          pending.delete(response.id!);
          if (response.error) waiting.reject(new Error(JSON.stringify(response.error)));
          else waiting.resolve(response.result);
        }
      }
    }
  })().catch((error) => {
    for (const p of pending.values()) p.reject(error);
  });
  function send(message: unknown, split = false) {
    const body = JSON.stringify(message);
    const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    if (split) {
      void child.stdin.write(bytes.subarray(0, 17));
      void child.stdin.write(bytes.subarray(17));
    } else void child.stdin.write(bytes);
    void child.stdin.flush();
  }
  return {
    notify: (method: string, params?: unknown) => send({ jsonrpc: "2.0", method, params }),
    request(method: string, params?: unknown, split = false): Promise<unknown> {
      const requestId = ++id;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rej(new Error(`Timed out: ${method}. ${stderr}`));
        }, 10_000);
        pending.set(requestId, { resolve: res, reject: rej, timer });
        send({ jsonrpc: "2.0", id: requestId, method, params }, split);
      });
    },
    async close() {
      try {
        if (child.exitCode === null) {
          await this.request("shutdown");
          this.notify("exit");
        }
      } finally {
        child.kill();
        await child.exited;
        for (const p of pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error("LSP closed"));
        }
        pending.clear();
      }
    },
  };
}

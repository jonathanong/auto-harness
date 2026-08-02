import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { MemorySessionStore } from "./memory-store.js";

type LocalServerOptions = {
  port?: number;
  store?: MemorySessionStore;
  publicBaseUrl?: string;
};

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createLocalApp(options: LocalServerOptions = {}): {
  store: MemorySessionStore;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  const store =
    options.store ??
    new MemorySessionStore({
      publicBaseUrl: options.publicBaseUrl ?? "http://localhost:3000",
    });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && url.pathname === "/api/v1/sessions") {
      try {
        const body = await readJson(req);
        const result = store.create(body);
        if (!result.ok) {
          send(res, 400, {
            error: { code: "VALIDATION_ERROR", message: result.error },
          });
          return;
        }
        send(res, 201, result.session);
        return;
      } catch {
        send(res, 400, {
          error: { code: "VALIDATION_ERROR", message: "invalid JSON body" },
        });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/api/v1/sessions") {
      send(res, 200, { items: store.list() });
      return;
    }

    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && sessionMatch) {
      const id = sessionMatch[1]!;
      const session = store.get(id);
      if (!session) {
        send(res, 404, {
          error: { code: "NOT_FOUND", message: "session not found" },
        });
        return;
      }
      send(res, 200, session);
      return;
    }

    send(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
  };

  return { store, handler };
}

export async function startLocalServer(
  options: LocalServerOptions = {},
): Promise<{ port: number; close: () => Promise<void>; store: MemorySessionStore }> {
  const port = options.port ?? 7420;
  const { store, handler } = createLocalApp(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      resolve();
    });
    server.on("error", reject);
  });

  return {
    port,
    store,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

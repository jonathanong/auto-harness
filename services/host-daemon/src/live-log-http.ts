import { createServer, type Server } from "node:http";

import type { SessionLogChunk } from "@auto-harness/shared";

const LIVE_PATH = /^\/sessions\/([^/]+)\/logs\/stream$/;

export function liveLogPortFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.HARNESS_DAEMON_LIVE_LOG_PORT?.trim();
  if (raw === "off" || raw === "0") return undefined;
  if (!raw) return 7424;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export function startLiveLogHttp(options: {
  port: number;
  subscribe: (sessionId: string, emit: (chunk: SessionLogChunk) => void) => () => void;
  log?: (line: string) => void;
}): { close: () => Promise<void>; server: Server } {
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const match = LIVE_PATH.exec(path);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const unsubscribe = options.subscribe(decodeURIComponent(match[1]!), (chunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });
    req.on("close", unsubscribe);
  });
  server.listen(options.port, "127.0.0.1", () => {
    options.log?.(`live log stream listening on 127.0.0.1:${String(options.port)}`);
  });
  server.on("error", (error) => {
    options.log?.(`live log stream unavailable: ${error.message}`);
  });
  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

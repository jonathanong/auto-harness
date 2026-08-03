import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentWireMessage } from "@auto-harness/shared";

import type { ControlPlane } from "./control-plane.ts";
import type { MemorySessionStore } from "./memory-store.ts";

export type LocalServerOptions = {
  port?: number;
  store?: MemorySessionStore;
  plane?: ControlPlane;
  publicBaseUrl?: string;
  /**
   * When true (default for startLocalServer), open DynamoDB Local and hydrate.
   * Unit tests may pass an in-process plane without DynamoDB.
   */
  useDynamo?: boolean;
  /** Attach /ws agent hub (default true for startLocalServer). */
  enableWs?: boolean;
  onAgentMessage?: (agentId: string, msg: AgentWireMessage) => void;
};

export type RouteCtx = {
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
};

export function readJson(req: IncomingMessage): Promise<unknown> {
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

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    // Keep headers already set (e.g. CORS) — do not pass a headers object.
    res.writeHead(204);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  const len = Buffer.byteLength(payload);
  // Prefer setHeader so prior CORS headers stay; fall back for minimal test fakes.
  if (typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", len);
    res.writeHead(status);
  } else {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": len,
    });
  }
  res.end(payload);
}

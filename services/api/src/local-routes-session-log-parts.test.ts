import { createServer } from "node:http";

import { gzipJsonlLines } from "@auto-harness/shared";
import { afterEach, describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { LogRecord } from "./control-plane-types.ts";

const admins = () =>
  Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString("base64url");

function gzipPart(content: string, seq: number): Buffer {
  return gzipJsonlLines([
    JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      stream: "stdout",
      content,
      seq,
    }),
  ]);
}

function seedSession(plane: ControlPlane, repositoryId = "repo-a"): string {
  plane.createRepository({
    id: repositoryId,
    name: repositoryId,
    url: `https://example.test/${repositoryId}.git`,
  });
  plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
  plane.createSession({
    repositoryId,
    prompt: "a",
    target: { commandId: "cmd-a" },
    timeout: 10,
  });
  const session = plane.listSessions().find((item) => item.repositoryId === repositoryId)!;
  plane.state.sessions.set(session.id, {
    ...plane.state.sessions.get(session.id)!,
    hostId: "host-a",
    status: "running",
  });
  return session.id;
}

async function listen(
  handler: (req: never, res: never) => void | Promise<void>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req as never, res as never);
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("PUT /api/v1/sessions/:id/log-parts", () => {
  it("accepts an unauthenticated local gzip part and serves it on GET /logs", async () => {
    const plane = new ControlPlane();
    const sessionId = seedSession(plane);
    const { handler } = createLocalApp({
      plane,
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    });
    const server = await listen(handler);
    close = server.close;
    const put = await fetch(
      `${server.base}/api/v1/sessions/${sessionId}/log-parts?seqStart=1&seqEnd=1`,
      {
        method: "PUT",
        headers: { "content-type": "application/gzip" },
        body: new Uint8Array(gzipPart("hello world", 1)),
      },
    );
    expect(put.status).toBe(200);
    const logs = await fetch(`${server.base}/api/v1/sessions/${sessionId}/logs`);
    expect(logs.status).toBe(200);
    const { items } = (await logs.json()) as { items: LogRecord[] };
    expect(
      items.some((item) => item.stream === "stdout" && item.content.includes("hello world")),
    ).toBe(true);
  });

  it("rejects a host-bound key for a different host", async () => {
    const plane = new ControlPlane();
    const sessionId = seedSession(plane);
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "other-host",
      role: "agent",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-b",
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const server = await listen(handler);
    close = server.close;
    const put = await fetch(
      `${server.base}/api/v1/sessions/${sessionId}/log-parts?seqStart=1&seqEnd=1`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/gzip",
        },
        body: new Uint8Array(gzipPart("nope", 1)),
      },
    );
    expect(put.status).toBe(404);
  });
});

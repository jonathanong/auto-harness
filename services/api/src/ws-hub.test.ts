/* eslint-disable max-lines */
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { ControlPlane } from "./control-plane.ts";
import { AuthService } from "./auth.ts";
import { createPlaneWsBridge, parseHostMessage } from "./ws-hub.ts";

describe("createPlaneWsBridge", () => {
  it("enforces the configured per-connection message budget and emits a safe event", async () => {
    const events: Array<{ outcome: string; bucket: string; limit: number; actorKey: string }> = [];
    const bridge = createPlaneWsBridge({
      maxMessagesPerSecond: 1,
      onRateLimitEvent: (event) => events.push(event),
    });
    const server = createServer();
    const hub = bridge.attach(server, new ControlPlane());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "host:register",
            hostId: "a1",
            worktrees: [],
            commandProfiles: [],
          }),
        );
        ws.send(
          JSON.stringify({ type: "host:keepalive", hostId: "a1", at: new Date().toISOString() }),
        );
      });
      ws.on("close", resolve);
      ws.on("error", reject);
    });

    expect(closeCode).toBe(1008);
    expect(events).toEqual([
      { outcome: "denied", bucket: "host", limit: 1, actorKey: "websocket-connection" },
    ]);
    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("rejects malformed nested messages before they reach the control plane", () => {
    const valid = {
      type: "host:register",
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    };
    expect(parseHostMessage(valid)).toEqual(valid);
    expect(parseHostMessage({ ...valid, draining: true })).toEqual({ ...valid, draining: true });
    expect(parseHostMessage({ ...valid, draining: false })).toBe(null);
    expect(
      parseHostMessage({ ...valid, worktrees: [{ ...valid.worktrees[0], labels: [1] }] }),
    ).toBe(null);
    expect(parseHostMessage({ type: "session:status", sessionId: "s", status: "bogus" })).toBe(
      null,
    );
    expect(parseHostMessage({ type: "session:ack", sessionId: "s" })).toBe(null);
    expect(
      parseHostMessage({
        type: "session:status",
        sessionId: "s",
        status: "completed",
        worktreeId: "wt-1",
        attemptId: "attempt-1",
      }),
    ).toMatchObject({ type: "session:status", attemptId: "attempt-1" });
    expect(
      parseHostMessage({
        type: "session:status",
        sessionId: "s",
        status: "completed",
        cliResumeRef: "bad\u0000ref",
      }),
    ).toBe(null);
    expect(parseHostMessage({ type: "host:status", hostId: "a1", draining: true })).toEqual({
      type: "host:status",
      hostId: "a1",
      draining: true,
    });
    expect(parseHostMessage({ type: "host:status", hostId: "a1", draining: false })).toBe(null);
    expect(
      parseHostMessage({
        type: "session:status",
        sessionId: "s",
        status: "completed",
        cliResumeRef: "💾".repeat(129),
      }),
    ).toBe(null);
    expect(
      parseHostMessage({
        type: "session:log",
        sessionId: "s",
        attemptId: "a",
        stream: "stdout",
        content: "x",
        timestamp: new Date().toISOString(),
        seq: Number.POSITIVE_INFINITY,
      }),
    ).toBe(null);
    expect(
      parseHostMessage({
        type: "session:usage",
        sessionId: "s",
        worktreeId: "wt-1",
        attemptId: "attempt-1",
        usage: {
          kind: "delta",
          sequence: 1,
          inputTokens: "2",
          source: "cli",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ type: "session:usage", attemptId: "attempt-1" });
    expect(
      parseHostMessage({
        type: "session:usage",
        sessionId: "s",
        worktreeId: "wt-1",
        attemptId: "attempt-1",
        usage: { kind: "delta", sequence: 1, source: "cli" },
      }),
    ).toBe(null);
  });

  it("registers an agent, delivers session:assign, then confirms its in-memory ACK once", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({
      onHostMessage: bridge.onHostMessage,
      idFactory: () => "sess-1",
      shardCount: 1,
    });
    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["echo"],
      providerId: null,
    });
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });

    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
      server.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no port");
    }

    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
      let ackConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "host:register",
            hostId: "a1",
            protocolVersion: 1,
            worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
            commandProfiles: ["echo-prompt"],
            runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
          }),
        );
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        received.push(msg);
        if (msg.type === "host:registered") {
          plane.createSession({
            repositoryId: "r1",
            prompt: "p",
            target: { commandId: "cmd-echo" },
            timeout: 10,
          });
          plane.assignQueued();
        }
        if (msg.type === "session:assign") {
          const assignment = msg as unknown as {
            sessionId: string;
            worktreeId: string;
            attemptId: string;
          };
          ws.send(
            JSON.stringify({
              type: "session:ack",
              sessionId: assignment.sessionId,
              worktreeId: assignment.worktreeId,
              attemptId: assignment.attemptId,
            }),
          );
        }
        if (msg.type === "session:acknowledged") {
          // Keep the in-memory socket open long enough to catch a duplicate
          // direct WS reply after the bridge callback's confirmation.
          ackConfirmationTimer ??= setTimeout(() => {
            ws.close();
            resolve();
          }, 50);
        }
      });
      ws.on("error", (error) => {
        if (ackConfirmationTimer) clearTimeout(ackConfirmationTimer);
        reject(error);
      });
      setTimeout(() => {
        reject(new Error("timeout"));
      }, 3000);
    });

    expect(received.some((m) => (m as { type: string }).type === "session:assign")).toBe(true);
    expect(received).toContainEqual({
      type: "session:acknowledged",
      sessionId: "sess-1",
      attemptId: expect.any(String),
    });
    expect(
      received.filter(
        (m) =>
          (m as { type?: string; sessionId?: string }).type === "session:acknowledged" &&
          (m as { sessionId?: string }).sessionId === "sess-1",
      ),
    ).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    hub.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.hostCount()).toBe(0);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });

  it("sends host:draining only after the durable status handler confirms it", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const handled = vi.spyOn(plane, "handleHostMessageDurable").mockImplementation(async (msg) => {
      if (msg.type === "host:register") {
        plane.state.hostConnection.set(msg.hostId, "connection-1");
        return { ok: true, connectionId: "connection-1" };
      }
      if (msg.type === "host:status") return { ok: true, hostDraining: msg.hostId };
      return { ok: false, error: "unexpected message" };
    });
    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "host:register",
            hostId: "a1",
            worktrees: [],
            commandProfiles: [],
          }),
        ),
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string };
        received.push(message);
        if (message.type === "host:registered") {
          ws.send(JSON.stringify({ type: "host:status", hostId: "a1", draining: true }));
        }
        if (message.type === "host:draining") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    expect(received).toContainEqual({ type: "host:draining", hostId: "a1" });
    expect(handled).toHaveBeenLastCalledWith(
      { type: "host:status", hostId: "a1", draining: true },
      "connection-1",
      false,
    );
    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("authenticates a bound service account through the Authorization header", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({
      name: "agent-a",
      role: "agent",
      boundHostId: "a1",
    });
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    const opened = await openRegisteredHost({
      bridge,
      plane,
      auth,
      headers: { authorization: `Bearer ${apiKey}` },
      registration: hostRegistration("a1"),
    });
    opened.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened.hub.hostCount()).toBe(0);
    await opened.close();
  });

  it("accepts legacy session logs without attemptId after protocol version 0 registration", async () => {
    const bridge = createPlaneWsBridge({ logBatchDelayMs: 1 });
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("legacy-host", 0),
    });
    plane.state.sessions.set("sess-1", {
      id: "sess-1",
      hostId: "legacy-host",
      attemptId: "owned-attempt",
      status: "running",
    } as never);
    opened.ws.send(
      JSON.stringify({
        type: "session:log",
        sessionId: "sess-1",
        stream: "stdout",
        content: "legacy",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      }),
    );
    await vi.waitFor(() =>
      expect(plane.getLogs("sess-1").map((record) => record.content)).toEqual(["legacy"]),
    );
    await opened.close();
  });

  it("rejects logs missing attemptId on a fenced protocol connection", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("modern-host", 1),
    });
    plane.state.sessions.set("sess-1", {
      id: "sess-1",
      hostId: "modern-host",
      attemptId: "owned-attempt",
      status: "running",
    } as never);
    const closeCode = waitForClose(opened.ws);
    opened.ws.send(
      JSON.stringify({
        type: "session:log",
        sessionId: "sess-1",
        stream: "stdout",
        content: "missing-attempt",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      }),
    );
    expect(await closeCode).toBe(1008);
    expect(plane.getLogs("sess-1")).toEqual([]);
    await opened.close();
  });

  it("does not disconnect a host that emits a delayed log for a reassigned session", async () => {
    const bridge = createPlaneWsBridge({ logBatchDelayMs: 1 });
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("old-host", 1),
    });
    seedReassignedSession(plane);
    opened.ws.send(sessionLog({ attemptId: "attempt-1", content: "stale" }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(opened.ws.readyState).toBe(WebSocket.OPEN);
    expect(plane.getLogs("sess-1")).toEqual([]);
    await opened.close();
  });

  it("still rejects a current-attempt log from a host that does not own the session", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("old-host", 1),
    });
    seedReassignedSession(plane);
    const closeCode = waitForClose(opened.ws);
    opened.ws.send(sessionLog({ attemptId: "attempt-2", content: "spoofed" }));
    expect(await closeCode).toBe(1008);
    await opened.close();
  });

  it("ignores a delayed ack for a session reassigned to another host", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("old-host", 1),
    });
    seedReassignedSession(plane);
    opened.ws.send(
      JSON.stringify({
        type: "session:ack",
        sessionId: "sess-1",
        worktreeId: "wt-1",
        attemptId: "attempt-1",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(opened.ws.readyState).toBe(WebSocket.OPEN);
    await opened.close();
  });

  it("rejects a current-attempt non-log frame for a session owned by another host", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("old-host", 1),
    });
    seedReassignedSession(plane);
    const closeCode = waitForClose(opened.ws);
    opened.ws.send(
      JSON.stringify({
        type: "session:ack",
        sessionId: "sess-1",
        worktreeId: "wt-2",
        attemptId: "attempt-2",
      }),
    );
    expect(await closeCode).toBe(1008);
    await opened.close();
  });

  it("rejects a log for a session that is not in the control plane", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane();
    const opened = await openRegisteredHost({
      bridge,
      plane,
      registration: hostRegistration("orphan-host", 1),
    });
    const closeCode = waitForClose(opened.ws);
    opened.ws.send(sessionLog({ sessionId: "missing", attemptId: "attempt-1", content: "orphan" }));
    expect(await closeCode).toBe(1008);
    await opened.close();
  });
});

type Bridge = ReturnType<typeof createPlaneWsBridge>;

function hostRegistration(hostId: string, protocolVersion?: number) {
  return {
    type: "host:register",
    hostId,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
    commandProfiles: [],
    runtime: {
      daemonVersion: protocolVersion === 0 ? "0.0.0" : "1.0.0",
      gitVersion: "2.36.0",
      gitReady: true,
    },
  };
}

function seedReassignedSession(plane: ControlPlane): void {
  plane.state.sessions.set("sess-1", {
    id: "sess-1",
    hostId: "new-host",
    attemptId: "attempt-2",
    status: "running",
  } as never);
}

function sessionLog({
  sessionId = "sess-1",
  attemptId,
  content,
}: {
  sessionId?: string;
  attemptId: string;
  content: string;
}): string {
  return JSON.stringify({
    type: "session:log",
    sessionId,
    attemptId,
    stream: "stdout",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    seq: 1,
  });
}

async function openRegisteredHost({
  bridge,
  plane,
  registration,
  auth,
  headers,
}: {
  bridge: Bridge;
  plane: ControlPlane;
  registration: ReturnType<typeof hostRegistration>;
  auth?: AuthService;
  headers?: Record<string, string>;
}): Promise<{
  ws: WebSocket;
  hub: ReturnType<Bridge["attach"]>;
  close(): Promise<void>;
}> {
  const server = createServer();
  const hub = bridge.attach(server, plane, auth);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const ws = headers
    ? new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers })
    : new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify(registration)));
    const onMessage = (raw: WebSocket.RawData) => {
      if (JSON.parse(String(raw)).type !== "host:registered") return;
      ws.off("message", onMessage);
      resolve();
    };
    ws.on("message", onMessage);
    ws.once("error", reject);
  });
  return {
    ws,
    hub,
    async close() {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function waitForClose(ws: WebSocket): Promise<number> {
  return await new Promise((resolve, reject) => {
    ws.once("close", (code) => resolve(code));
    ws.once("error", reject);
  });
}

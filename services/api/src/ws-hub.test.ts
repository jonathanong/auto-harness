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
            worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
            commandProfiles: ["echo-prompt"],
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
    expect(received).toContainEqual({ type: "session:acknowledged", sessionId: "sess-1" });
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
    const server = createServer();
    const hub = bridge.attach(server, plane, auth);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
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
        if (JSON.parse(String(raw)).type === "host:registered") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.hostCount()).toBe(0);
    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
});

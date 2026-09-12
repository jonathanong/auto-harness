/* eslint-disable max-lines -- WebSocket ACK and socket-race cases share one server harness. */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { HostToServerMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("WebSocket durable ACK replies", () => {
  it("replies after a durable acknowledgement commits", async () => {
    const run = await startHarness(new AckPlane());
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(ack()));
      await expect(waitForMessage(socket)).resolves.toEqual({
        type: "session:acknowledged",
        sessionId: "ack-session",
        attemptId: "attempt-1",
      });
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("does not reply when the socket closes during the durable commit", async () => {
    const plane = new AckPlane(true);
    const run = await startHarness(plane);
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(ack()));
      await plane.started;
      socket.close();
      await waitForClose(socket);
      plane.release();
      await Promise.resolve();
    } finally {
      plane.release();
      await run.close();
    }
  });

  it("replies with session:status-acknowledged once a terminal report durably applies", async () => {
    const run = await startHarness(new StatusPlane());
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(status()));
      await expect(waitForMessage(socket)).resolves.toEqual({
        type: "session:status-acknowledged",
        sessionId: "ack-session",
        attemptId: "attempt-1",
        retryAccepted: false,
        terminalHookHandoffId: "handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      });
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("replies after command-start authorization and terminal-hook settlement", async () => {
    const run = await startHarness(new ProtocolAckPlane());
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(commandStart()));
      await expect(waitForMessage(socket)).resolves.toEqual({
        type: "session:command-start-acknowledged",
        sessionId: "ack-session",
        attemptId: "attempt-1",
      });
      socket.send(JSON.stringify(terminalHookComplete()));
      await expect(waitForMessage(socket)).resolves.toEqual({
        type: "session:terminal-hook-acknowledged",
        sessionId: "ack-session",
        handoffId: "handoff",
      });
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("delivers pending terminal hooks immediately after registration", async () => {
    const run = await startHarness(new RegistrationHandoffPlane());
    try {
      const socket = await openSocket(run.origin);
      const messages = waitForMessages(socket, 2);
      socket.send(JSON.stringify(registrationMessage()));
      await expect(messages).resolves.toEqual([
        expect.objectContaining({ type: "host:registered" }),
        expect.objectContaining({
          type: "session:terminal-hook",
          sessionId: "lost-session",
          handoffId: "handoff",
        }),
      ]);
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("authorizes a replayed terminal-hook completion and rejects mismatched handoffs", async () => {
    const accepted = await startHarness(
      new TerminalAuthorizationPlane({
        terminalHookHandoffSettled: { handoffId: "handoff", hostId: "ack-host", settledAt: "now" },
      }),
    );
    try {
      const socket = await registered(accepted.origin);
      socket.send(JSON.stringify(terminalHookComplete()));
      await expect(waitForMessage(socket)).resolves.toMatchObject({
        type: "session:terminal-hook-acknowledged",
        handoffId: "handoff",
      });
      socket.close();
      await waitForClose(socket);
    } finally {
      await accepted.close();
    }

    const rejected = await startHarness(
      new TerminalAuthorizationPlane({
        terminalHookHandoff: { handoffId: "other", hostId: "ack-host" },
      }),
    );
    try {
      const socket = await registered(rejected.origin);
      socket.send(JSON.stringify(terminalHookComplete()));
      await waitForClose(socket);
    } finally {
      await rejected.close();
    }
  });

  it("disconnects a registration that completes without a connection after close", async () => {
    const plane = new DelayedRegistrationPlane();
    const run = await startHarness(plane);
    try {
      const socket = await openSocket(run.origin);
      socket.send(JSON.stringify(registrationMessage()));
      await plane.started;
      socket.close();
      await waitForClose(socket);
      plane.release();
      await Promise.resolve();
    } finally {
      plane.release();
      await run.close();
    }
  });

  it("handles a compatibility registration without a connection fence", async () => {
    const run = await startHarness(new NoConnectionPlane());
    try {
      const socket = await openSocket(run.origin);
      socket.send(JSON.stringify(registrationMessage()));
      await expect(waitForMessage(socket)).resolves.toMatchObject({ type: "host:registered" });
      socket.send(
        JSON.stringify({
          type: "host:keepalive",
          hostId: "ack-host",
          at: new Date().toISOString(),
        }),
      );
      await expect(waitForMessage(socket)).resolves.toMatchObject({ type: "host:keepalive-ack" });
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it.each(["registration", "keepalive"] as const)(
    "stops %s handoff delivery when the exact socket closes between items",
    async (mode) => {
      const plane = new ClosingHandoffPlane(mode);
      const run = await startHarness(plane);
      plane.hostSockets = run.hostSockets;
      try {
        const socket =
          mode === "registration" ? await openSocket(run.origin) : await registered(run.origin);
        const closed = waitForClose(socket);
        if (mode === "registration") socket.send(JSON.stringify(registrationMessage()));
        else {
          socket.send(
            JSON.stringify({
              type: "host:keepalive",
              hostId: "ack-host",
              at: new Date().toISOString(),
            }),
          );
        }
        await closed;
      } finally {
        await run.close();
      }
    },
  );
});

class AckPlane extends ControlPlane {
  private releaseAck: (() => void) | undefined;
  private readonly gate: Promise<void> | undefined;
  private readonly markStarted: () => void;
  readonly started: Promise<void>;

  constructor(block = false) {
    super();
    this.started = new Promise((resolve) => (this.markStarted = resolve));
    this.gate = block ? new Promise((resolve) => (this.releaseAck = resolve)) : undefined;
  }

  release(): void {
    this.releaseAck?.();
  }

  override getSession(id: string): ReturnType<ControlPlane["getSession"]> {
    return id === "ack-session"
      ? ({ hostId: "ack-host" } as ReturnType<ControlPlane["getSession"]>)
      : null;
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "session:ack") {
      this.markStarted();
      await this.gate;
      return { ok: true, sessionAcknowledged: message.sessionId };
    }
    return super.handleHostMessageDurable(message);
  }
}

function ack() {
  return {
    type: "session:ack" as const,
    sessionId: "ack-session",
    worktreeId: null,
    attemptId: "attempt-1",
  };
}

class StatusPlane extends ControlPlane {
  override getSession(id: string): ReturnType<ControlPlane["getSession"]> {
    return id === "ack-session"
      ? ({ hostId: "ack-host" } as ReturnType<ControlPlane["getSession"]>)
      : null;
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "session:status") {
      return {
        ok: true,
        sessionStatusAcknowledged: {
          sessionId: message.sessionId,
          attemptId: message.attemptId!,
          retryAccepted: false,
          terminalHookHandoffId: "handoff",
          terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
        },
      };
    }
    return super.handleHostMessageDurable(message);
  }
}

function status() {
  return {
    type: "session:status" as const,
    sessionId: "ack-session",
    worktreeId: null,
    attemptId: "attempt-1",
    status: "completed" as const,
  };
}

function commandStart() {
  return {
    type: "session:command-start" as const,
    sessionId: "ack-session",
    worktreeId: null,
    attemptId: "attempt-1",
  };
}

function terminalHookComplete() {
  return {
    type: "session:terminal-hook-complete" as const,
    sessionId: "ack-session",
    handoffId: "handoff",
  };
}

class ProtocolAckPlane extends ControlPlane {
  override getSession(id: string): ReturnType<ControlPlane["getSession"]> {
    return id === "ack-session"
      ? ({
          hostId: "ack-host",
          terminalHookHandoff: { hostId: "ack-host", handoffId: "handoff" },
        } as ReturnType<ControlPlane["getSession"]>)
      : null;
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "session:command-start") {
      return {
        ok: true,
        sessionCommandStartAcknowledged: {
          sessionId: message.sessionId,
          attemptId: message.attemptId,
        },
      };
    }
    if (message.type === "session:terminal-hook-complete") {
      return {
        ok: true,
        sessionTerminalHookAcknowledged: {
          sessionId: message.sessionId,
          handoffId: message.handoffId,
        },
      };
    }
    return super.handleHostMessageDurable(message);
  }
}

class RegistrationHandoffPlane extends ControlPlane {
  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "host:register") {
      return {
        ok: true,
        connectionId: "handoff-connection",
        terminalHookHandoffs: [
          {
            type: "session:terminal-hook" as const,
            handoffId: "handoff",
            sessionId: "lost-session",
            repositoryId: "repo",
            worktreeId: null,
            status: "failed" as const,
          },
        ],
      };
    }
    return super.handleHostMessageDurable(message);
  }
}

class TerminalAuthorizationPlane extends ControlPlane {
  private readonly session: Record<string, unknown>;

  constructor(session: Record<string, unknown>) {
    super();
    this.session = session;
  }

  override getSession(id: string): ReturnType<ControlPlane["getSession"]> {
    return id === "ack-session"
      ? ({ hostId: "ack-host", ...this.session } as ReturnType<ControlPlane["getSession"]>)
      : null;
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "session:terminal-hook-complete") {
      return {
        ok: true,
        sessionTerminalHookAcknowledged: {
          sessionId: message.sessionId,
          handoffId: message.handoffId,
        },
      };
    }
    return super.handleHostMessageDurable(message);
  }
}

class DelayedRegistrationPlane extends ControlPlane {
  private releaseRegistration: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => (this.releaseRegistration = resolve));
  private readonly markStarted: () => void;
  readonly started: Promise<void>;

  constructor() {
    super();
    this.started = new Promise((resolve) => (this.markStarted = resolve));
  }

  release(): void {
    this.releaseRegistration?.();
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "host:register") {
      this.markStarted();
      await this.gate;
      return { ok: true };
    }
    return super.handleHostMessageDurable(message);
  }
}

class NoConnectionPlane extends ControlPlane {
  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "host:register" || message.type === "host:keepalive") {
      return { ok: true };
    }
    return super.handleHostMessageDurable(message);
  }
}

class ClosingHandoffPlane extends ControlPlane {
  hostSockets: Map<string, WebSocket> | undefined;
  private readonly mode: "registration" | "keepalive";

  constructor(mode: "registration" | "keepalive") {
    super();
    this.mode = mode;
  }

  private handoffs() {
    const closeSocket = () => this.hostSockets?.get("ack-host")?.close();
    return {
      *[Symbol.iterator]() {
        yield { type: "session:terminal-hook", handoffId: "first", sessionId: "first" };
        closeSocket();
        yield { type: "session:terminal-hook", handoffId: "second", sessionId: "second" };
      },
    };
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    const result = await super.handleHostMessageDurable(message);
    if (
      (this.mode === "registration" && message.type === "host:register") ||
      (this.mode === "keepalive" && message.type === "host:keepalive")
    ) {
      return { ...result, terminalHookHandoffs: this.handoffs() } as never;
    }
    return result;
  }
}

async function startHarness(plane: ControlPlane) {
  const server = createServer();
  const bridge = createPlaneWsBridge();
  const hub = bridge.attach(server, plane);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `ws://127.0.0.1:${address.port}`,
    hostSockets: bridge.hostSockets,
    async close() {
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function registered(origin: string): Promise<WebSocket> {
  const socket = await openSocket(origin);
  socket.send(JSON.stringify(registrationMessage()));
  await waitForMessage(socket);
  return socket;
}

async function openSocket(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(`${origin}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function registrationMessage() {
  return {
    type: "host:register",
    hostId: "ack-host",
    worktrees: [],
    commandProfiles: [],
  };
}

async function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

async function waitForMessages(
  socket: WebSocket,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => {
      messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
      if (messages.length === count) resolve(messages);
    });
    socket.once("error", reject);
  });
}

async function waitForClose(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

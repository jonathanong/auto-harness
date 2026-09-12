/* eslint-disable max-lines -- command-start authorization timing cases share one daemon fixture. */
import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage, SessionAssign } from "@auto-harness/shared";

import { DaemonLoop, type DaemonTransport } from "./daemon-loop.ts";

class ProtocolTransport implements DaemonTransport {
  readonly sent: HostToServerMessage[] = [];
  deferCommandStarts = false;
  private readonly commandStartResolves: Array<() => void> = [];
  private messageHandler: ((message: HostWireMessage) => void) | undefined;
  private registrationHandler: ((protocolVersion?: number) => void) | undefined;

  async send(message: HostToServerMessage): Promise<void> {
    this.sent.push(message);
    if (this.deferCommandStarts && message.type === "session:command-start") {
      await new Promise<void>((resolve) => this.commandStartResolves.push(resolve));
    }
  }

  resolveCommandStarts(): void {
    for (const resolve of this.commandStartResolves.splice(0)) resolve();
  }

  onMessage(handler: (message: HostWireMessage) => void): void {
    this.messageHandler = handler;
  }

  onRegistered(handler: (protocolVersion?: number) => void): void {
    this.registrationHandler = handler;
  }

  negotiate(protocolVersion: number): void {
    this.registrationHandler?.(protocolVersion);
  }

  deliver(message: HostWireMessage): void {
    this.messageHandler?.(message);
  }

  close(): void {}
}

const assign: SessionAssign = {
  sessionId: "session-1",
  attemptId: "attempt-1",
  repositoryId: "repo-1",
  prompt: "run",
  resolvedArgv: ["cli"],
  timeout: 30,
  worktreeId: "worktree-1",
};

function authorize(loop: DaemonLoop, signal = new AbortController().signal): Promise<boolean> {
  return (
    loop as unknown as {
      authorizeCommandStart(assign: SessionAssign, signal?: AbortSignal): Promise<boolean>;
    }
  ).authorizeCommandStart(assign, signal);
}

function authorizeWithoutSignal(loop: DaemonLoop): Promise<boolean> {
  return (
    loop as unknown as {
      authorizeCommandStart(assign: SessionAssign, signal?: AbortSignal): Promise<boolean>;
    }
  ).authorizeCommandStart(assign);
}

async function startedLoop(transport: ProtocolTransport): Promise<DaemonLoop> {
  const loop = new DaemonLoop({
    config: {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [],
    },
    transport,
    runtime: {
      daemonVersion: "test",
      gitVersion: null,
      gitReady: false,
      gitReadinessReason: "git_unavailable",
    },
  });
  await loop.start();
  return loop;
}

describe("DaemonLoop command-start authorization", () => {
  it("sends v3 command-start and waits for the matching acknowledgement", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(3);
      const pending = authorize(loop);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      transport.deliver({
        type: "session:command-start-acknowledged",
        sessionId: assign.sessionId,
        attemptId: assign.attemptId,
      });
      await expect(pending).resolves.toBe(true);
    } finally {
      loop.stop();
    }
  });

  it("replays pending v3 authorization after reconnect registration", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(3);
      const pending = authorize(loop);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      transport.negotiate(3);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(2);
      transport.deliver({
        type: "session:command-start-acknowledged",
        sessionId: assign.sessionId,
        attemptId: assign.attemptId,
      });
      await expect(pending).resolves.toBe(true);
    } finally {
      loop.stop();
    }
  });

  it("retries an unacknowledged authorization on a healthy keepalive", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(3);
      const pending = authorize(loop);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);

      // Let the first local write settle without delivering its server ACK.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await loop.keepalive();
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(2);

      transport.deliver({
        type: "session:command-start-acknowledged",
        sessionId: assign.sessionId,
        attemptId: assign.attemptId,
      });
      await expect(pending).resolves.toBe(true);
    } finally {
      loop.stop();
    }
  });

  it("rejects pending v3 authorization when reconnect downgrades the protocol", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(3);
      const pending = authorize(loop);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);

      transport.negotiate(2);
      await expect(pending).resolves.toBe(false);

      // An ACK from the superseded v3 connection must not reopen the gate.
      transport.deliver({
        type: "session:command-start-acknowledged",
        sessionId: assign.sessionId,
        attemptId: assign.attemptId,
      });
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);
    } finally {
      loop.stop();
    }
  });

  it("bypasses command-start authorization for protocol 2", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(2);
      await expect(authorizeWithoutSignal(loop)).resolves.toBe(true);
      expect(transport.sent.some((message) => message.type === "session:command-start")).toBe(
        false,
      );
    } finally {
      loop.stop();
    }
  });

  it("allows legacy callers without a cancellation signal and refuses an already-aborted v3 launch", async () => {
    const transport = new ProtocolTransport();
    const loop = await startedLoop(transport);
    try {
      await expect(authorize(loop)).resolves.toBe(true);
      transport.negotiate(3);
      await expect(authorize(loop, AbortSignal.abort())).resolves.toBe(false);
      expect(transport.sent.some((message) => message.type === "session:command-start")).toBe(
        false,
      );
    } finally {
      loop.stop();
    }
  });

  it("does not enqueue a duplicate command-start while the first send is still pending", async () => {
    const transport = new ProtocolTransport();
    transport.deferCommandStarts = true;
    const loop = await startedLoop(transport);
    try {
      transport.negotiate(3);
      const pending = authorize(loop);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);

      transport.negotiate(3);
      expect(
        transport.sent.filter((message) => message.type === "session:command-start"),
      ).toHaveLength(1);

      transport.resolveCommandStarts();
      transport.deliver({
        type: "session:command-start-acknowledged",
        sessionId: assign.sessionId,
        attemptId: assign.attemptId,
      });
      await expect(pending).resolves.toBe(true);
    } finally {
      loop.stop();
    }
  });
});

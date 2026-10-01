/* eslint-disable max-lines -- end-to-end materialization scenarios share one gated git runner. */
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { SpawnProcessRunner, type ProcessRunner } from "./executor.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

type Registered = Extract<HostToServerMessage, { type: "host:register" }>;

const registeredIds = (message: Registered | undefined) =>
  (message?.worktrees ?? []).map((worktree) => worktree.id).toSorted();

/** Real git, except `worktree add` into a path listed in `gates` waits (or fails) on demand. */
function gatedGit(gates: Map<string, Promise<"ok" | "fail">>): ProcessRunner {
  const real = new SpawnProcessRunner();
  return {
    async run(opts) {
      const add = opts.argv.indexOf("add");
      if (opts.argv.includes("worktree") && add > 0) {
        const gate = gates.get(opts.argv.at(-2)!);
        if (gate && (await gate) === "fail") {
          opts.onChunk({ stream: "stderr", data: "fatal: simulated checkout failure" });
          return { exitCode: 128, timedOut: false, signal: null };
        }
      }
      return real.run(opts);
    },
  };
}

function assign(worktreeId: string): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId: `s-${worktreeId}`,
    attemptId: `a-${worktreeId}`,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId,
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop worktree materialization", () => {
  it("adopts a new inventory immediately while slow or failing checkouts finish separately", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const slowPath = join(root, "wt-slow");
      const badPath = join(root, "wt-bad");
      let releaseSlow!: (value: "ok") => void;
      const slow = new Promise<"ok">((resolve) => (releaseSlow = resolve));
      let failBad!: (value: "fail") => void;
      const bad = new Promise<"fail">((resolve) => (failBad = resolve));
      const gates = new Map<string, Promise<"ok" | "fail">>();
      for (const path of [slowPath, badPath]) {
        gates.set(path, path === slowPath ? slow : bad);
        gates.set(`/private${path}`, path === slowPath ? slow : bad);
      }

      const sent: HostToServerMessage[] = [];
      const logs: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const latest: { next?: DaemonConfig } = {};
      const loop = new DaemonLoop({
        config,
        transport,
        processRunner: gatedGit(gates),
        onLog: (line) => logs.push(line),
        refreshInventory: async () => latest.next ?? config,
      });
      await loop.start();
      const registers = () => sent.filter((m): m is Registered => m.type === "host:register");
      expect(registeredIds(registers().at(-1))).toEqual(["wt-1"]);

      const repository = config.repositories[0]!;
      const second = join(root, "wt-second-repo");
      const next: DaemonConfig = {
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-slow", name: "wt-slow", path: slowPath, labels: [] },
              { id: "wt-bad", name: "wt-bad", path: badPath, labels: [] },
            ],
          },
          {
            ...repository,
            id: "other",
            worktrees: [{ id: "wt-other", name: "wt-other", path: second, labels: [] }],
          },
        ],
      };

      latest.next = next;
      // Adoption does not wait for any checkout, so it cannot trip the 10s refresh deadline.
      await loop.applyInventory(next);
      expect(loop.isDraining()).toBe(false);
      expect(registeredIds(registers().at(-1))).toEqual(["wt-1"]);

      // An assignment waits for its pending checkout inside its own deadline; one whose checkout
      // fails is then rejected locally instead of being claimed against a missing directory.
      transport.deliver(assign("wt-bad"));
      releaseSlow("ok");
      failBad("fail");
      await expect(loop.waitForIdle()).rejects.toThrow(/not ready yet: demo\/wt-bad/);
      await loop.materializeWorktrees();

      // The other repository and the slow worktree became assignable; the failed one did not.
      // Readiness announcements are fire-and-forget; the keepalive republishes any that coalesced.
      await vi.waitFor(async () => {
        await loop.keepalive();
        expect(registeredIds(registers().at(-1))).toEqual(["wt-1", "wt-other", "wt-slow"]);
      });
      expect(logs.some((line) => line.includes("wt-bad") && line.includes("not ready"))).toBe(true);
      transport.deliver(assign("wt-slow"));
      await loop.waitForIdle();
      expect(sent.some((m) => m.type === "session:status" && m.sessionId === "s-wt-slow")).toBe(
        true,
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("re-advertises a worktree that became ready while an acknowledgement was pending", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const repository = config.repositories[0]!;
      await loop.applyInventory({
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-late", name: "wt-late", path: join(root, "wt-late"), labels: [] },
            ],
          },
        ],
      });
      const registersBefore = sent.filter((m) => m.type === "host:register").length;
      // Keepalive notices the advertised set is stale and publishes it without waiting for a poll.
      (loop as unknown as { hasPendingAcknowledgement(): boolean }).hasPendingAcknowledgement =
        () => true;
      await loop.materializeWorktrees();
      expect(sent.filter((m) => m.type === "host:register")).toHaveLength(registersBefore);
      (loop as unknown as { hasPendingAcknowledgement(): boolean }).hasPendingAcknowledgement =
        () => false;
      await expect(loop.keepalive()).resolves.toBe(false);
      const last = sent.filter((m): m is Registered => m.type === "host:register").at(-1);
      expect(registeredIds(last)).toEqual(["wt-1", "wt-late"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("registers without a slow startup checkout and advertises it once it finishes", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const gates = new Map<string, Promise<"ok" | "fail">>();
      let release!: (value: "ok") => void;
      const slow = new Promise<"ok">((resolve) => (release = resolve));
      gates.set(join(config.repositories[0]!.worktrees[0]!.path), slow);
      gates.set(`/private${config.repositories[0]!.worktrees[0]!.path}`, slow);
      const sent: HostToServerMessage[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({
          sendToServer: (message) => sent.push(message),
        }),
        processRunner: gatedGit(gates),
        startupMaterializeWaitMs: 20,
      });
      await loop.start();
      const registers = () => sent.filter((m): m is Registered => m.type === "host:register");
      expect(registeredIds(registers().at(-1))).toEqual([]);
      release("ok");
      await vi.waitFor(() => expect(registeredIds(registers().at(-1))).toEqual(["wt-1"]));
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it.each(["publish", "assign"] as const)(
    "does not wait for later stalled checkouts (%s)",
    async (mode) => {
      const { root, config, cleanup } = await makeRepo();
      try {
        const repository = config.repositories[0]!;
        const first = repository.worktrees[0]!;
        const stalledPath = join(root, "wt-stalled");
        const gates = new Map<string, Promise<"ok" | "fail">>();
        let releaseFirst!: (value: "ok") => void;
        let releaseStalled!: (value: "ok") => void;
        const firstGate = new Promise<"ok">((resolve) => (releaseFirst = resolve));
        const stalledGate = new Promise<"ok">((resolve) => (releaseStalled = resolve));
        for (const prefix of ["", "/private"]) {
          gates.set(`${prefix}${first.path}`, firstGate);
          gates.set(`${prefix}${stalledPath}`, stalledGate);
        }
        const sent: HostToServerMessage[] = [];
        const transport = createAcknowledgingLoopbackTransport({
          sendToServer: (message) => sent.push(message),
        });
        const loop = new DaemonLoop({
          config: {
            ...config,
            repositories: [
              {
                ...repository,
                worktrees: [
                  ...repository.worktrees,
                  { id: "wt-stalled", name: "wt-stalled", path: stalledPath, labels: [] },
                ],
              },
            ],
          },
          transport,
          processRunner: gatedGit(gates),
          startupMaterializeWaitMs: 20,
        });
        await loop.start();
        const registers = () => sent.filter((m): m is Registered => m.type === "host:register");
        expect(registeredIds(registers().at(-1))).toEqual([]);

        // The second checkout stays stalled: the first is published or unblocks its assignment alone.
        if (mode === "assign") transport.deliver(assign("wt-1"));
        releaseFirst("ok");
        if (mode === "assign") {
          await vi.waitFor(
            () =>
              expect(
                sent.some((m) => m.type === "session:status" && m.sessionId === "s-wt-1"),
              ).toBe(true),
            { timeout: 10_000 },
          );
        } else {
          await vi.waitFor(() => expect(registeredIds(registers().at(-1))).toEqual(["wt-1"]), {
            timeout: 10_000,
          });
        }
        releaseStalled("ok");
        await loop.waitForIdle();
        loop.stop();
      } finally {
        cleanup();
      }
    },
  );

  it("does not publish a readiness registration while an inventory apply is in flight", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const sent: HostToServerMessage[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({
          sendToServer: (message) => sent.push(message),
        }),
      });
      await loop.start();
      const repository = config.repositories[0]!;
      await loop.applyInventory({
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-mid", name: "wt-mid", path: join(root, "wt-mid"), labels: [] },
            ],
          },
        ],
      });
      const internals = loop as unknown as {
        applyingInventory: number;
        readinessDeferred: boolean;
      };
      const before = sent.filter((m) => m.type === "host:register").length;
      internals.applyingInventory = 1;
      await loop.materializeWorktrees();
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent.filter((m) => m.type === "host:register")).toHaveLength(before);
      expect(internals.readinessDeferred).toBe(true);
      internals.applyingInventory = 0;
      // The next apply to finish publishes the readiness that was deferred meanwhile.
      await loop.applyInventory({ ...config });
      expect(internals.readinessDeferred).toBe(false);
      await loop.keepalive();
      const last = sent.filter((m): m is Registered => m.type === "host:register").at(-1);
      expect(registeredIds(last)).toEqual(["wt-1", "wt-mid"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("retries pending checkouts from the keepalive without any inventory poll", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const sent: HostToServerMessage[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({
          sendToServer: (message) => sent.push(message),
        }),
      });
      await loop.start();
      const repository = config.repositories[0]!;
      await loop.applyInventory({
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-kept", name: "wt-kept", path: join(root, "wt-kept"), labels: [] },
            ],
          },
        ],
      });
      await loop.keepalive();
      await loop.materializeWorktrees();
      await loop.keepalive();
      const last = sent.filter((m): m is Registered => m.type === "host:register").at(-1);
      expect(registeredIds(last)).toEqual(["wt-1", "wt-kept"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("lets an assignment wait for its pending checkout instead of bouncing it", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const repository = config.repositories[0]!;
      const next: DaemonConfig = {
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-fast", name: "wt-fast", path: join(root, "wt-fast"), labels: [] },
            ],
          },
        ],
      };
      const loop = new DaemonLoop({ config, transport, refreshInventory: async () => next });
      await loop.start();
      transport.deliver(assign("wt-fast"));
      await loop.waitForIdle();
      expect(sent.some((m) => m.type === "session:status" && m.sessionId === "s-wt-fast")).toBe(
        true,
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("holds a pending target for its checkout even without an inventory loader", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const repository = config.repositories[0]!;
      await loop.applyInventory({
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-solo", name: "wt-solo", path: join(root, "wt-solo"), labels: [] },
            ],
          },
        ],
      });
      transport.deliver(assign("wt-solo"));
      await loop.waitForIdle();
      expect(sent.some((m) => m.type === "session:status" && m.sessionId === "s-wt-solo")).toBe(
        true,
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("logs a materialization that rejects outright", async () => {
    const { config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      const logs: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({ sendToServer: () => {} }),
        onLog: (line) => logs.push(line),
      });
      await loop.start();
      const manager = (
        loop as unknown as { worktrees: { materializePending: () => Promise<void> } }
      ).worktrees;
      vi.spyOn(manager, "materializePending").mockRejectedValueOnce(new Error("boom"));
      await loop.materializeWorktrees();
      expect(logs).toContain("worktree materialization failed: boom");
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("logs a failed re-registration instead of leaking an unhandled rejection", async () => {
    const { root, config, cleanup } = await makeRepo({ materializeWorktree: true });
    try {
      let failRegister = false;
      const logs: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "host:register" && failRegister) throw new Error("socket closed");
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => logs.push(line) });
      await loop.start();
      const repository = config.repositories[0]!;
      await loop.applyInventory({
        ...config,
        repositories: [
          {
            ...repository,
            worktrees: [
              ...repository.worktrees,
              { id: "wt-late", name: "wt-late", path: join(root, "wt-late"), labels: [] },
            ],
          },
        ],
      });
      failRegister = true;
      await loop.materializeWorktrees();
      await new Promise((resolve) => setImmediate(resolve));
      expect(logs.some((line) => line.includes("worktree registration update failed"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("starts with a failing checkout without crashing and leaves it unadvertised", async () => {
    const { root, config, cleanup } = await makeRepo();
    try {
      const gates = new Map<string, Promise<"ok" | "fail">>();
      const failing = Promise.resolve("fail" as const);
      gates.set(join(root, "wt-1"), failing);
      gates.set(`/private${join(root, "wt-1")}`, failing);
      const sent: HostToServerMessage[] = [];
      const logs: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({
          sendToServer: (message) => sent.push(message),
        }),
        processRunner: gatedGit(gates),
        onLog: (line) => logs.push(line),
      });
      await loop.start();
      const last = sent.filter((m): m is Registered => m.type === "host:register").at(-1);
      expect(registeredIds(last)).toEqual([]);
      expect(logs.some((line) => line.includes("not ready"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not materialize on a host without a usable git", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createAcknowledgingLoopbackTransport({ sendToServer: () => undefined }),
        runtime: { gitReady: false } as never,
      });
      await expect(loop.materializeWorktrees()).resolves.toBeUndefined();
      loop.stop();
    } finally {
      cleanup();
    }
  });
});

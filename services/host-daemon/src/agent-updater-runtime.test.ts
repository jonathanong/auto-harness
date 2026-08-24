import { describe, expect, it } from "vitest";

import {
  MAX_UPDATE_POLL_MS,
  createDaemonUpdater,
  parseUpdatePollMs,
  startUpdatePoll,
} from "./agent-updater-runtime.ts";
import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";
import { baseOpts, seededFs } from "./host-service-test-helpers.ts";

describe("daemon updater runtime", () => {
  it("parses poll intervals and stays disabled without update env", () => {
    expect(parseUpdatePollMs(undefined)).toBe(60 * 60_000);
    expect(parseUpdatePollMs("")).toBe(60 * 60_000);
    expect(parseUpdatePollMs("0")).toBe(0);
    expect(parseUpdatePollMs(String(MAX_UPDATE_POLL_MS))).toBe(MAX_UPDATE_POLL_MS);
    expect(() => parseUpdatePollMs("-1")).toThrow("HARNESS_UPDATE_POLL_MS");
    expect(() => parseUpdatePollMs(String(MAX_UPDATE_POLL_MS + 1))).toThrow(
      "HARNESS_UPDATE_POLL_MS",
    );
    expect(
      createDaemonUpdater({
        loop: {} as DaemonLoop,
        env: {},
        log: () => undefined,
        error: () => undefined,
      }),
    ).toBeUndefined();
    expect(() =>
      createDaemonUpdater({
        loop: {} as DaemonLoop,
        env: { HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/m.json" },
        log: () => undefined,
        error: () => undefined,
      }),
    ).toThrow("both required");
    expect(() =>
      createDaemonUpdater({
        loop: {} as DaemonLoop,
        env: {
          HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/m.json",
          HARNESS_UPDATE_PUBLIC_KEY: "key",
        },
        log: () => undefined,
        error: () => undefined,
      }),
    ).toThrow("supervisor restart adapter is required");
    let runs = 0;
    expect(() =>
      startUpdatePoll(
        {
          run: async () => {
            runs += 1;
          },
        } as never,
        {
          pollMs: MAX_UPDATE_POLL_MS + 1,
          log: () => undefined,
          error: () => undefined,
        },
      ),
    ).toThrow("HARNESS_UPDATE_POLL_MS");
    expect(runs).toBe(0);
  });

  it("polls once when pollMs is zero", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
      });
      const logs: string[] = [];
      const updater = createDaemonUpdater({
        loop,
        env: {
          HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/manifest.json",
          HARNESS_UPDATE_PUBLIC_KEY: "not-a-key",
          HARNESS_UPDATE_POLL_MS: "0",
          HARNESS_UPDATE_INSTALL_DIR: "/tmp/auto-harness-updater-runtime-test",
        },
        log: (line) => logs.push(line),
        error: () => undefined,
        service: baseOpts({ platform: "linux", uid: 0, fs: seededFs() }),
        fetchFn: async () => {
          throw new Error("offline");
        },
      });
      expect(updater).toBeDefined();
      expect(
        createDaemonUpdater({
          loop,
          env: {
            HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/manifest.json",
            HARNESS_UPDATE_PUBLIC_KEY: "not-a-key",
            HARNESS_UPDATE_INSTALL_DIR: "/tmp/ah-update",
            HARNESS_DAEMON_VERSION: "1.0.0",
          },
          log: () => undefined,
          error: () => undefined,
          service: baseOpts({ platform: "linux", uid: 0, fs: seededFs() }),
        }),
      ).toBeDefined();
      const stop = startUpdatePoll(updater!, {
        pollMs: 0,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stop();
      expect(logs.some((line) => line.includes("updater"))).toBe(true);
      const stopPoll = startUpdatePoll(updater!, {
        pollMs: 60_000,
        log: (line) => logs.push(line),
        error: (line) => logs.push(line),
      });
      await stopPoll();
      const errors: string[] = [];
      const stopFail = startUpdatePoll(
        { run: async () => Promise.reject(new Error("boom")) } as never,
        { pollMs: 0, log: () => undefined, error: (line) => errors.push(line) },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stopFail();
      expect(errors.some((line) => line.includes("updater failed: boom"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("waits for an active poll before shutdown completes", async () => {
    let release: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stop = startUpdatePoll({ run: async () => active } as never, {
      pollMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});

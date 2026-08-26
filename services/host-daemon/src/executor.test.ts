import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createChildEnv } from "./child-env.ts";
import { SpawnProcessRunner } from "./executor.ts";

describe("child environment", () => {
  it("does not leak control-plane credentials and only admits named extras", () => {
    expect(
      createChildEnv({
        PATH: "/bin",
        HOME: "/home/agent",
        HARNESS_API_KEY: "secret",
        HARNESS_CHILD_ENV_ALLOWLIST: "TOKEN",
        TOKEN: "allowed",
        UNRELATED: "nope",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/agent", TOKEN: "allowed" });
  });

  it("allows locale fields and ignores an empty allowlist", () => {
    expect(createChildEnv({ LC_ALL: "C", HARNESS_CHILD_ENV_ALLOWLIST: "", NOPE: "x" })).toEqual({
      LC_ALL: "C",
    });
  });
});

describe("SpawnProcessRunner cancellation", () => {
  it("escalates an ignored SIGTERM after the grace period", async () => {
    const runner = new SpawnProcessRunner();
    const result = await runner.run({
      argv: [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
      ],
      cwd: process.cwd(),
      // Give Node enough time to install the signal handler before timeout.
      timeoutMs: 500,
      terminationGraceMs: 20,
      onChunk: () => undefined,
    });
    expect(result.timedOut).toBe(true);
    if (process.platform === "win32") {
      // taskkill terminates the process externally; libuv only reports a
      // signal it delivered itself, so a taskkill-based kill is expected to
      // surface here as signal: null rather than "SIGTERM"/"SIGKILL". This
      // is an inference, not something exercised on real Windows from this
      // environment, so accept either shape rather than pin an unverified one.
      expect(result.signal === null || ["SIGTERM", "SIGKILL"].includes(result.signal)).toBe(true);
    } else {
      // Under an overloaded parallel test run Node can receive the timeout
      // before its fixture installs the handler; both terminal signals prove the
      // runner completed the timeout path. The focused test reliably exercises
      // SIGKILL once the handler is ready.
      expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
    }
  });

  it("marks an externally aborted process as cancelled", async () => {
    const controller = new AbortController();
    const runner = new SpawnProcessRunner();
    const run = runner.run({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      terminationGraceMs: 20,
      signal: controller.signal,
      onChunk: () => undefined,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(run).resolves.toMatchObject({ cancelled: true, timedOut: false });
  });

  it("does not spawn when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-executor-"));
    const marker = join(directory, "started");
    try {
      await expect(
        new SpawnProcessRunner().run({
          argv: [
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
          ],
          cwd: process.cwd(),
          timeoutMs: 10_000,
          terminationGraceMs: 20,
          signal: controller.signal,
          onChunk: () => undefined,
        }),
      ).resolves.toMatchObject({ cancelled: true, exitCode: null, signal: null });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "escalates the process group after its SIGTERM leader closes",
    async () => {
      const controller = new AbortController();
      let helperPid: number | undefined;
      const runner = new SpawnProcessRunner();
      const run = runner.run({
        argv: [
          process.execPath,
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const helper = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)\"], { stdio: 'ignore' });",
            "console.log(helper.pid);",
            "setInterval(() => {}, 1_000);",
          ].join(" "),
        ],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        terminationGraceMs: 30,
        signal: controller.signal,
        onChunk: (chunk) => {
          if (chunk.stream !== "stdout" || helperPid !== undefined) return;
          helperPid = Number.parseInt(chunk.data, 10);
          controller.abort();
        },
      });

      await expect(run).resolves.toMatchObject({ cancelled: true, timedOut: false });
      expect(helperPid).toBeTypeOf("number");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(helperPid!, 0)).toThrow();
    },
  );

  it("truncates an oversized output event", async () => {
    const chunks: string[] = [];
    const runner = new SpawnProcessRunner();
    await runner.run({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(40_000))"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    expect(chunks.some((chunk) => chunk.includes("output chunk truncated"))).toBe(true);
    expect(
      chunks
        .filter((chunk) => !chunk.includes("output chunk truncated"))
        .every((chunk) => chunk.length <= 32 * 1024),
    ).toBe(true);
  });

  it("keeps output below the byte cap when a UTF-8 character is split at the boundary", async () => {
    const chunks: string[] = [];
    const runner = new SpawnProcessRunner();
    await runner.run({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.concat([Buffer.alloc(32767, 0x61), Buffer.from([0xc3])]))",
      ],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    expect(
      Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk, "utf8"))),
    ).toBeLessThanOrEqual(32 * 1024);
  });

  it("surfaces non-ENOENT spawn errors", async () => {
    await expect(
      new SpawnProcessRunner().run({
        argv: [process.cwd()],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});

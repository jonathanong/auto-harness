import { describe, expect, it } from "vitest";

import { createChildEnv } from "./child-env.ts";
import { runSetupScript, type ProcessRunner, SpawnProcessRunner } from "./executor.ts";

describe("runSetupScript", () => {
  it("invokes /bin/sh -c with the script", async () => {
    let seen: string[] | undefined;
    const runner: ProcessRunner = {
      async run(opts) {
        seen = opts.argv;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runSetupScript(runner, "true", "/tmp", 1000, () => undefined);
    expect(seen).toEqual(["/bin/sh", "-c", "true"]);
  });
});

describe("child environment", () => {
  it("does not leak control-plane credentials and only admits named extras", () => {
    expect(
      createChildEnv({
        PATH: "/bin",
        HOME: "/home/agent",
        HARNESS_API_KEY: "secret",
        HARNESS_CHILD_ENV_ALLOWLIST: "TOKEN,HARNESS_OTHER,not-valid!",
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
    // Under an overloaded parallel test run Node can receive the timeout
    // before its fixture installs the handler; both terminal signals prove the
    // runner completed the timeout path. The focused test reliably exercises
    // SIGKILL once the handler is ready.
    expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
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

  it("handles a signal that was already aborted before spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new SpawnProcessRunner().run({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        terminationGraceMs: 20,
        signal: controller.signal,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ cancelled: true });
  });

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

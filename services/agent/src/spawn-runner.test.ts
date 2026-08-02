import { describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./executor.js";

describe("SpawnProcessRunner", () => {
  it("runs a real process without shell", async () => {
    const runner = new SpawnProcessRunner();
    let out = "";
    const result = await runner.run({
      argv: ["echo", "hi"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onChunk: (c) => {
        out += c.data;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(out).toContain("hi");
  });

  it("rejects empty argv and empty command", async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run({
        argv: [],
        cwd: process.cwd(),
        timeoutMs: 1000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(/argv/);
    await expect(
      runner.run({
        argv: [""],
        cwd: process.cwd(),
        timeoutMs: 1000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(/argv/);
  });

  it("times out long processes", async () => {
    const runner = new SpawnProcessRunner();
    const result = await runner.run({
      argv: ["sleep", "5"],
      cwd: process.cwd(),
      timeoutMs: 50,
      onChunk: () => undefined,
    });
    expect(result.timedOut).toBe(true);
  });

  it("captures stderr and non-zero exit", async () => {
    const runner = new SpawnProcessRunner();
    let err = "";
    const result = await runner.run({
      argv: ["node", "-e", "console.error('e'); process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onChunk: (c) => {
        if (c.stream === "stderr") {
          err += c.data;
        }
      },
    });
    expect(result.exitCode).toBe(3);
    expect(err).toContain("e");
  });

  it("rejects missing command", async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run({
        argv: ["definitely-not-a-command-xyz"],
        cwd: process.cwd(),
        timeoutMs: 1000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow();
  });
});

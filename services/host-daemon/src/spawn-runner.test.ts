import { describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./executor.ts";

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
    ).rejects.toThrow(/not found in PATH|ENOENT/);
  });

  it("explains missing cwd instead of bare spawn ENOENT", async () => {
    const runner = new SpawnProcessRunner();
    await expect(
      runner.run({
        argv: ["git", "status"],
        cwd: "/tmp/auto-harness-missing-cwd-xyz",
        timeoutMs: 1000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow(/working directory does not exist/);
  });

  it("preserves latin1 stdout bytes across chunk boundaries", async () => {
    const chunks: string[] = [];
    const result = await new SpawnProcessRunner().run({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xc3])); process.stdout.write(Buffer.from([0xa9, 0x00]))",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      preserveOutputChunks: true,
      outputEncoding: "latin1",
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(chunks.join(""), "latin1")).toEqual(Buffer.from([0xc3, 0xa9, 0x00]));
  });

  it("keeps preserved stderr as UTF-8 when stdout uses latin1", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await new SpawnProcessRunner().run({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0xff])); process.stderr.write('café')",
      ],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      preserveOutputChunks: true,
      outputEncoding: "latin1",
      onChunk: (chunk) => {
        if (chunk.stream === "stdout") stdout.push(chunk.data);
        else stderr.push(chunk.data);
      },
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(stdout.join(""), "latin1")).toEqual(Buffer.from([0xff]));
    expect(stderr.join("")).toBe("café");
  });

  it("writes stdin bytes to the child", async () => {
    const chunks: string[] = [];
    const payload = Buffer.from([0xff, 0x00, 0x61]);
    const result = await new SpawnProcessRunner().run({
      argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      preserveOutputChunks: true,
      outputEncoding: "latin1",
      stdin: payload,
      onChunk: (chunk) => chunks.push(chunk.data),
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(chunks.join(""), "latin1")).toEqual(payload);
  });
});

import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { SecretRedactingProcessRunner } from "./secret-redacting-runner.ts";

const secret = "abc";

function runner(chunks: Array<{ stream: "stdout" | "stderr"; data: string }>): ProcessRunner {
  return {
    async run(options) {
      for (const chunk of chunks) options.onChunk(chunk);
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
}

async function redact(
  chunks: Array<{ stream: "stdout" | "stderr"; data: string }>,
): Promise<string> {
  const output: string[] = [];
  await new SecretRedactingProcessRunner(runner(chunks), secret).run({
    argv: ["tool"],
    cwd: "/tmp",
    timeoutMs: 1_000,
    onChunk: (chunk) => output.push(chunk.data),
  });
  return output.join("");
}

describe("SecretRedactingProcessRunner", () => {
  it("preserves a merged terminal runner's stream capability", () => {
    const mergedRunner: ProcessRunner = {
      outputStreams: "merged",
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    expect(new SecretRedactingProcessRunner(mergedRunner, secret).outputStreams).toBe("merged");
  });

  it("redacts a complete secret in one chunk", async () => {
    await expect(redact([{ stream: "stdout", data: "xabc!" }])).resolves.toBe("x[redacted]!");
  });

  it("redacts every split boundary independently for both streams", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      for (let split = 1; split < secret.length; split += 1) {
        const output = await redact([
          { stream, data: `x${secret.slice(0, split)}` },
          { stream, data: `${secret.slice(split)}!` },
        ]);
        expect(output).toBe("x[redacted]!");
        expect(output).not.toContain(secret);
      }
    }
  });

  it("redacts a self-overlapping secret before retaining a possible next prefix", async () => {
    const repeated = "aaaa";
    for (let split = 0; split <= repeated.length; split += 1) {
      const chunks = split === 0 ? [repeated] : [repeated.slice(0, split), repeated.slice(split)];
      const output: string[] = [];
      await new SecretRedactingProcessRunner(
        runner(chunks.map((data) => ({ stream: "stdout", data }))),
        repeated,
      ).run({
        argv: ["tool"],
        cwd: "/tmp",
        timeoutMs: 1_000,
        onChunk: (chunk) => output.push(chunk.data),
      });
      expect(output.join("")).toBe("[redacted]");
    }
  });

  it("buffers stdout and stderr independently and flushes a non-secret suffix", async () => {
    const output = await redact([
      { stream: "stdout", data: "xab" },
      { stream: "stderr", data: "yab" },
      { stream: "stdout", data: "c" },
      { stream: "stderr", data: "c" },
      { stream: "stdout", data: "ab" },
    ]);
    expect(output).toBe("xy[redacted][redacted]ab");
    expect(output).not.toContain(secret);
  });

  it("redacts an exact secret in a runner error", async () => {
    const failing: ProcessRunner = {
      async run() {
        throw new Error(`remote rejected ${secret}`);
      },
    };
    await expect(
      new SecretRedactingProcessRunner(failing, secret).run({
        argv: ["tool"],
        cwd: "/tmp",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("remote rejected [redacted]");
  });

  it("redacts an exact secret in a non-Error runner rejection", async () => {
    const failing: ProcessRunner = {
      async run() {
        return await Promise.reject(`remote rejected ${secret}`);
      },
    };
    await expect(
      new SecretRedactingProcessRunner(failing, secret).run({
        argv: ["tool"],
        cwd: "/tmp",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).rejects.toThrow("remote rejected [redacted]");
  });

  it("redacts an exact secret in a structured agent summary", async () => {
    const structured: ProcessRunner = {
      async run() {
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          agentSummary: `finished with ${secret}`,
        };
      },
    };
    await expect(
      new SecretRedactingProcessRunner(structured, secret).run({
        argv: ["tool"],
        cwd: "/tmp",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ agentSummary: "finished with [redacted]" });
  });
});

import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
import {
  UsageCapturingProcessRunner,
  executableStem,
  parseCliUsage,
  resolveCliProvider,
} from "./usage-adapter.ts";

const observedAt = "2026-01-01T00:00:00.000Z";

describe("CLI provider identity", () => {
  it("resolves trusted catalog argv stems", () => {
    expect(executableStem("C:\\\\bin\\\\Claude.EXE")).toBe("claude");
    expect(resolveCliProvider(["/usr/local/bin/codex", "exec"])).toBe("codex");
    expect(resolveCliProvider(["echo", "hi"])).toBeUndefined();
    expect(resolveCliProvider([])).toBeUndefined();
  });
});

describe("parseCliUsage", () => {
  it("ignores providerless and non-JSON output", () => {
    expect(
      parseCliUsage({ argv: ["echo"], output: '{"usage":{"input_tokens":1}}', observedAt }),
    ).toEqual({});
    expect(parseCliUsage({ argv: ["claude", "-p"], output: "hello world", observedAt })).toEqual(
      {},
    );
  });

  it("parses Claude JSON result usage", () => {
    const output = JSON.stringify({
      type: "result",
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: 3,
      },
    });
    expect(parseCliUsage({ argv: ["claude", "-p"], output, observedAt })).toEqual({
      usage: {
        kind: "cumulative",
        sequence: 0,
        source: "cli",
        observedAt,
        inputTokens: "12",
        outputTokens: "4",
        cachedInputTokens: "3",
      },
    });
  });

  it("parses Codex NDJSON turn.completed usage and Gemini metadata", () => {
    const codex = [
      '{"type":"item.completed"}',
      '{"type":"turn.completed","usage":{"input_tokens":"9","cached_input_tokens":1,"output_tokens":2}}',
    ].join("\n");
    expect(parseCliUsage({ argv: ["codex", "exec"], output: codex, observedAt }).usage).toEqual({
      kind: "cumulative",
      sequence: 0,
      source: "cli",
      observedAt,
      inputTokens: "9",
      cachedInputTokens: "1",
      outputTokens: "2",
    });

    expect(
      parseCliUsage({
        argv: ["gemini"],
        output:
          '{"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":7,"thoughtsTokenCount":1}}',
        observedAt,
      }).usage,
    ).toMatchObject({ inputTokens: "5", outputTokens: "7", reasoningTokens: "1" });
  });

  it("parses Grok nested token usage and structured quota errors", () => {
    const grok = JSON.stringify({
      payload: { info: { total_token_usage: { total_tokens: 11, inputTokens: 6 } } },
    });
    expect(parseCliUsage({ argv: ["grok", "-p"], output: grok, observedAt }).usage).toMatchObject({
      totalTokens: "11",
      inputTokens: "6",
    });
    expect(
      parseCliUsage({
        argv: ["claude"],
        output: '{"type":"error","error":{"type":"rate_limit_error"}}',
        observedAt,
      }).usageLimit,
    ).toBe(true);
    expect(
      parseCliUsage({
        argv: ["codex"],
        output: '{"usage":{"input_tokens":-1},"type":"insufficient_quota"}',
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
  });

  it("reads a JSON object embedded after a banner", () => {
    const output = 'Ready\n{"usage":{"input_tokens":2,"output_tokens":1}}\n';
    expect(parseCliUsage({ argv: ["claude"], output, observedAt }).usage?.inputTokens).toBe("2");
    expect(
      parseCliUsage({
        argv: ["claude"],
        output: '{"usage":{"input_tokens":0,"output_tokens":0}',
        observedAt,
      }).usage,
    ).toBeUndefined();
    expect(
      parseCliUsage({
        argv: ["claude"],
        output: '{"usage":{"input_tokens":4},"note":"say \\"hi\\""}\n{not json\n[1]\n',
        observedAt,
      }).usage?.inputTokens,
    ).toBe("4");
  });
});

describe("UsageCapturingProcessRunner", () => {
  it("attaches parsed usage without replacing an inner adapter report", async () => {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: '{"usage":{"input_tokens":8}}' });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const runner = new UsageCapturingProcessRunner(inner, () => observedAt);
    await expect(
      runner.run({
        argv: ["claude", "-p"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usage: { inputTokens: "8" } });

    const preset: ProcessRunner = {
      outputStreams: "merged",
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: '{"usage":{"input_tokens":1}}' });
        return {
          exitCode: 0,
          timedOut: false,
          signal: null,
          usage: {
            kind: "delta",
            sequence: 3,
            source: "cli",
            observedAt,
            inputTokens: "99",
          },
        };
      },
    };
    const wrapped = new UsageCapturingProcessRunner(preset, () => observedAt);
    expect(wrapped.outputStreams).toBe("merged");
    await expect(
      wrapped.run({
        argv: ["claude", "-p"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usage: { inputTokens: "99", sequence: 3 } });

    const limited: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: '{"type":"rate_limit_error"}' });
        return { exitCode: 1, timedOut: false, signal: null, usageLimit: true };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(limited, () => observedAt).run({
        argv: ["claude", "-p"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usageLimit: true });
  });
});

/* eslint-disable max-lines -- provider envelope acceptance and rejection cases share fixtures. */
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
  it("requires a provider structured-output flag", () => {
    expect(
      parseCliUsage({ argv: ["echo"], output: '{"usage":{"input_tokens":1}}', observedAt }),
    ).toEqual({});
    expect(parseCliUsage({ argv: ["claude", "-p"], output: "hello world", observedAt })).toEqual(
      {},
    );
    expect(
      parseCliUsage({
        argv: ["claude", "-p"],
        output: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 1 },
        }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("parses only a Claude result envelope", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: 3,
      },
    });
    expect(
      parseCliUsage({ argv: ["claude", "-p", "--output-format", "json"], output, observedAt }),
    ).toEqual({
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

  it("parses provider-specific Codex and Gemini envelopes", () => {
    const codex = [
      '{"type":"item.completed"}',
      '{"type":"turn.completed","usage":{"input_tokens":"9","cached_input_tokens":1,"output_tokens":2}}',
    ].join("\n");
    expect(
      parseCliUsage({ argv: ["codex", "exec", "--json"], output: codex, observedAt }).usage,
    ).toEqual({
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
        argv: ["gemini", "-p", "--output-format", "json"],
        output:
          '{"response":"done","usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":7,"thoughtsTokenCount":1}}',
        observedAt,
      }).usage,
    ).toMatchObject({ inputTokens: "5", outputTokens: "7", reasoningTokens: "1" });
  });

  it("rejects nested and forged records while accepting terminal structured errors", () => {
    const grok = JSON.stringify({
      response: "done",
      usage: { total_tokens: 11, input_tokens: 6 },
    });
    expect(
      parseCliUsage({
        argv: ["grok", "--output-format", "json", "-p"],
        output: grok,
        observedAt,
      }).usage,
    ).toMatchObject({ totalTokens: "11", inputTokens: "6" });
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output:
          '{"type":"result","subtype":"rate_limit_error","is_error":true,"error":{"type":"rate_limit_error"}}',
        observedAt,
      }).usageLimit,
    ).toBe(true);
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: '{"type":"turn.failed","error":{"type":"insufficient_quota"}}',
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output:
          'Ready\n{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":2}}\n',
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output: '{"type":"message","usage":{"input_tokens":2}}',
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: '{"usageMetadata":{"promptTokenCount":2}}',
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["grok", "--output-format", "json", "-p"],
        output: '{"usage":{"input_tokens":2}}',
        observedAt,
      }),
    ).toEqual({});
  });
});

describe("UsageCapturingProcessRunner", () => {
  it("attaches parsed usage without replacing an inner adapter report", async () => {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({
          stream: "stdout",
          data: '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":8}}',
        });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const runner = new UsageCapturingProcessRunner(inner, () => observedAt);
    await expect(
      runner.run({
        argv: ["claude", "-p", "--output-format", "json"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usage: { inputTokens: "8" } });

    const preset: ProcessRunner = {
      outputStreams: "merged",
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({
          stream: "stdout",
          data: '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1}}',
        });
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
        argv: ["claude", "-p", "--output-format", "json"],
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

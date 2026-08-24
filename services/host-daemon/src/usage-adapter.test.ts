/* eslint-disable max-lines -- provider envelope acceptance and rejection cases share fixtures. */
import { describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
import {
  UsageCapturingProcessRunner,
  executableStem,
  parseCliUsage,
  resolveCliProvider,
} from "./usage-adapter.ts";
import { jsonLines, jsonObject } from "./usage-adapter-json.ts";

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
        cache_creation_input_tokens: 2,
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
        cachedInputTokens: "5",
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
        argv: ["claude", "-p", "--output-format", "json"],
        output:
          '{"type":"result","subtype":"usage_limit","is_error":true,"error":{"type":"usage_limit"},"usage":{"input_tokens":6,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}',
        observedAt,
      }),
    ).toEqual({
      usage: {
        kind: "cumulative",
        sequence: 0,
        source: "cli",
        observedAt,
        inputTokens: "6",
        outputTokens: "2",
        cachedInputTokens: "7",
      },
      usageLimit: true,
    });
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
          '{"type":"message","usage":{"input_tokens":999}}\n' +
          'Ready\n\u001b[?25l{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":2,"output_tokens":1},"result":"brace: { not an envelope }"}\n\u001b[?25h',
        observedAt,
      }),
    ).toMatchObject({ usage: { inputTokens: "2", outputTokens: "1" } });
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

  it("finds a complete terminal envelope across mixed PTY diagnostics without accepting oversized output", () => {
    const pretty = JSON.stringify(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 23 },
      },
      null,
      2,
    );
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output: `warning: starting\r\n${pretty}\r\nwarning: complete`,
        observedAt,
      }),
    ).toMatchObject({ usage: { inputTokens: "23" } });
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output: `${"x".repeat(4 * 1024 * 1024)}${pretty}`,
        observedAt,
      }),
    ).toEqual({});
  });

  it("accepts provider flag aliases and rejects incomplete structured modes", () => {
    const claude = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 2 },
    });
    expect(
      parseCliUsage({
        argv: ["claude", "--print", "--output-format=json"],
        output: claude,
        observedAt,
      }),
    ).toMatchObject({ usage: { inputTokens: "2" } });
    expect(
      parseCliUsage({
        argv: ["gemini", "--prompt", "--output-format=json"],
        output: JSON.stringify({ response: "ok", usageMetadata: { inputTokens: 3 } }),
        observedAt,
      }),
    ).toMatchObject({ usage: { inputTokens: "3" } });
    expect(
      parseCliUsage({
        argv: ["grok", "--single", "--output-format=json"],
        output: JSON.stringify({ response: "ok", usage: { inputTokens: 4 } }),
        observedAt,
      }),
    ).toMatchObject({ usage: { inputTokens: "4" } });
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json=true"],
        output: '{"type":"turn.completed","usage":{"input_tokens":1}}',
        observedAt,
      }),
    ).toEqual({});
  });

  it("covers provider usage fallbacks, malformed usage, and all structured quota envelopes", () => {
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ response: "ok", stats: { usageMetadata: { outputTokens: 6 } } }),
        observedAt,
      }),
    ).toMatchObject({ usage: { outputTokens: "6" } });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ response: "ok", stats: { tokens: { totalTokens: 7 } } }),
        observedAt,
      }),
    ).toMatchObject({ usage: { totalTokens: "7" } });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ response: "ok", usageMetadata: { inputTokens: -1 } }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ error: { code: "RESOURCE_EXHAUSTED" } }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({ status: "error", error: { code: "RATE_LIMIT_ERROR" } }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({ type: "error", error: { status: "usage_limit" } }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({ response: "ok", usage: { reasoningTokens: "8", totalTokens: 9 } }),
        observedAt,
      }),
    ).toMatchObject({ usage: { reasoningTokens: "8", totalTokens: "9" } });
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output: JSON.stringify({ type: "result", subtype: "success", is_error: true }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({ response: "ok" }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({ text: "ok" }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("maps every token field and handles alternate structured error codes", () => {
    const usage = parseCliUsage({
      argv: ["claude", "-p", "--output-format", "json"],
      output: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {
          inputTokens: 1.9,
          outputTokens: "2",
          cachedInputTokens: "3",
          reasoningTokens: 4,
          totalTokens: "5",
        },
      }),
      observedAt,
    });
    expect(usage).toMatchObject({
      usage: {
        inputTokens: "1",
        outputTokens: "2",
        cachedInputTokens: "3",
        reasoningTokens: "4",
        totalTokens: "5",
      },
    });
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "result",
          subtype: "server_error",
          is_error: true,
          error: { code: "INSUFFICIENT_QUOTA" },
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "turn.failed", error: { status: "RATE_LIMIT_ERROR" } }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "turn.completed", usage: [] }),
        observedAt,
      }),
    ).toEqual({});
  });
});

describe("structured JSON scanners", () => {
  it("skips malformed and incomplete objects while finding a later valid envelope", () => {
    expect(jsonObject("{incomplete")).toBeUndefined();
    expect(jsonObject('{bad} {"ok":true}')).toEqual({ ok: true });
    expect(jsonObject(JSON.stringify({ message: 'brace { and quote "' }))).toEqual({
      message: 'brace { and quote "',
    });
    expect(jsonLines('\nnot-json\nnull\n[]\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });
});

describe("UsageCapturingProcessRunner", () => {
  it("passes through unstructured commands without capturing their output", async () => {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: "plain output" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["echo", "plain"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 0, timedOut: false, signal: null });
  });

  it("retains a complete structured envelope larger than 256 KiB", async () => {
    const envelope = JSON.stringify({
      response: "x".repeat(300 * 1024),
      usageMetadata: { promptTokenCount: 321 },
    });
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        for (let index = 0; index < envelope.length; index += 64 * 1024) {
          options.onChunk({ stream: "stdout", data: envelope.slice(index, index + 64 * 1024) });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["gemini", "-p", "--output-format", "json"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usage: { inputTokens: "321" } });
  });

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

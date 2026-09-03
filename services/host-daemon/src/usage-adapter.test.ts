/* eslint-disable max-lines -- provider envelope acceptance and rejection cases share fixtures. */
import { describe, expect, it } from "vitest";

import {
  MAX_OUTPUT_CHUNK_BYTES,
  OUTPUT_CHUNK_TRUNCATION_MARKER,
  type OutputChunk,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from "./executor.ts";
import { CODEX_PENDING_LINE_MAX_BYTES, foldCodexRecord } from "./usage-adapter-codex.ts";
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

  it("sums grok split-cache token fields from the documented json envelope", () => {
    // Grok CLI 1.0.13's --output-format json docs (and the #430 live probe) emit
    // Anthropic-style cache_read/cache_creation buckets, not cached_input_tokens.
    // cache_creation is non-zero so a first-key-wins mapping cannot pass.
    const output = JSON.stringify({
      text: "Here's a summary of the codebase...",
      stopReason: "end_turn",
      sessionId: "abc123",
      requestId: "xyz789",
      num_turns: 7,
      usage: {
        input_tokens: 7210,
        cache_read_input_tokens: 41000,
        cache_creation_input_tokens: 12,
        output_tokens: 1893,
        reasoning_tokens: 412,
        total_tokens: 50115,
      },
    });
    expect(
      parseCliUsage({ argv: ["grok", "-p", "--output-format", "json"], output, observedAt }),
    ).toEqual({
      usage: {
        kind: "cumulative",
        sequence: 0,
        source: "cli",
        observedAt,
        inputTokens: "7210",
        outputTokens: "1893",
        cachedInputTokens: "41012",
        reasoningTokens: "412",
        totalTokens: "50115",
      },
    });
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
    // The account-level 5h/weekly/model plan quota is enforced client-side, not as an
    // Anthropic API error: no rate_limit_error/usage_limit code, subtype still "success".
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output:
          '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"budget_exhausted","result":"You\'ve hit your weekly limit \xB7 resets 12pm (America/Los_Angeles)"}',
        observedAt,
      }).usageLimit,
    ).toBe(true);
    expect(
      parseCliUsage({
        argv: ["claude", "-p", "--output-format", "json"],
        output:
          '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":401}',
        observedAt,
      }).usageLimit,
    ).toBeUndefined();
    // Forward-compatible arm: OpenAI hasn't shipped a structured error code for this yet,
    // but the detector keeps a code-based check alongside the message check in case it does.
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

  it("detects grok/gemini CLI-authored usage-limit envelopes from first-party CLI source", () => {
    // Grok CLI 1.0.13 headless.rs: `{type:"error", message}` only. HTTP 429 maps to
    // ACP -32003, then format_rate_limited_user_message writes these sentences
    // (unicode apostrophe). Keep the structured-code arm as forward-compat.
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message:
            "You\u2019ve hit the rate limit for your plan. Upgrade your account or try again later.",
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message:
            "You\u2019ve hit your team\u2019s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later. See https://docs.x.ai/developers/rate-limits#rate-limit-tiers",
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message:
            "You\u2019ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok?referrer=grok-build",
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message:
            "You've hit the rate limit for your plan. Upgrade your account or try again later.",
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message: "Couldn't start session: permission denied",
        }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({ type: "error", message: "rate limit exceeded" }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["grok", "-p", "--output-format", "json"],
        output: JSON.stringify({
          type: "error",
          message: "You've hit your weekly limit · resets 12pm (America/Los_Angeles)",
        }),
        observedAt,
      }),
    ).toEqual({});

    // Gemini CLI 0.46.0 JsonFormatter.formatError: `{error:{type, message, code?}}`.
    // RESOURCE_EXHAUSTED is Google's RPC status copied into error.message; a bare
    // 429 is not enough (same overload risk as Claude HTTP 429).
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({
          error: {
            type: "Error",
            message:
              "[API Error: You exceeded your current quota, please check your plan and billing details. (Status: RESOURCE_EXHAUSTED)]\nPlease wait and try again later.",
            code: 1,
          },
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({
          error: {
            type: "GaxiosError",
            message:
              '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
            code: 429,
          },
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({
          error: { error: { status: "RESOURCE_EXHAUSTED" } },
        }),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({
          error: { type: "Error", message: "[API Error: boom]", code: 429 },
        }),
        observedAt,
      }),
    ).toEqual({});
    expect(
      parseCliUsage({
        argv: ["gemini", "-p", "--output-format", "json"],
        output: JSON.stringify({
          error: {
            type: "FatalAuthenticationError",
            message: "IneligibleTierError",
            code: 41,
          },
        }),
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

describe("codex usage-limit detection", () => {
  // Real JSONL captured from the failing live session sess-fa52d870: codex-cli emits its own
  // usage-limit sentence on `error.message`/top-level `message`, never a structured error code.
  const topLevelError =
    '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 7:25 PM."}';
  const turnFailed =
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 7:25 PM."}}';

  it("detects a top-level {type:error} envelope from sess-fa52d870", () => {
    expect(
      parseCliUsage({ argv: ["codex", "exec", "--json"], output: topLevelError, observedAt }),
    ).toEqual({ usageLimit: true });
  });

  it("detects a turn.failed envelope from sess-fa52d870", () => {
    expect(
      parseCliUsage({ argv: ["codex", "exec", "--json"], output: turnFailed, observedAt }),
    ).toEqual({ usageLimit: true });
  });

  it("detects usage limit from a full captured session transcript", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: [topLevelError, turnFailed].join("\n"),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
  });

  it("tolerates a curly-apostrophe variant of the sentence", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: '{"type":"error","message":"You’ve hit your usage limit today."}',
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
  });

  it("tolerates \\r\\n line endings from a PTY-wrapped session", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: [topLevelError, turnFailed].join("\r\n"),
        observedAt,
      }),
    ).toEqual({ usageLimit: true });
  });

  it("never trusts model-authored item.* content repeating the trigger phrase", () => {
    // Regression guard: an agent turn can be made to emit this exact sentence as ordinary
    // assistant text. Only codex's own error envelope (`error`/`turn.failed`) is trusted.
    const modelEcho = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "You've hit your usage limit." },
    });
    expect(
      parseCliUsage({ argv: ["codex", "exec", "--json"], output: modelEcho, observedAt }),
    ).toEqual({});
  });

  it("does not flag a turn.failed error with no usage-limit signal", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "turn.failed", error: { message: "network timeout" } }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("does not flag a turn.failed record with no error payload at all", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "turn.failed" }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("does not flag a top-level error record with a non-string message", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "error", message: { nested: true } }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("does not flag a top-level error record with no message at all", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: "error" }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("ignores records whose type is not a string", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ type: 42, message: "You've hit your usage limit." }),
        observedAt,
      }),
    ).toEqual({});
  });

  it("ignores a record with no type field", () => {
    expect(
      parseCliUsage({
        argv: ["codex", "exec", "--json"],
        output: JSON.stringify({ message: "You've hit your usage limit." }),
        observedAt,
      }),
    ).toEqual({});
  });
});

describe("foldCodexRecord", () => {
  it("folds a turn.completed usage record into an empty accumulator", () => {
    expect(
      foldCodexRecord({}, { type: "turn.completed", usage: { input_tokens: 4 } }, observedAt),
    ).toEqual({
      usage: { kind: "cumulative", sequence: 0, source: "cli", observedAt, inputTokens: "4" },
    });
  });

  it("merges a usage-limit record onto an accumulator that already has usage", () => {
    const withUsageAlready = foldCodexRecord(
      {},
      { type: "turn.completed", usage: { input_tokens: 4 } },
      observedAt,
    );
    expect(
      foldCodexRecord(withUsageAlready, { type: "error", message: "unrelated" }, observedAt),
    ).toBe(withUsageAlready);
    expect(
      foldCodexRecord(
        withUsageAlready,
        { type: "error", message: "You've hit your usage limit." },
        observedAt,
      ),
    ).toEqual({ ...withUsageAlready, usageLimit: true });
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

  it("defaults observedAt to the current time when no clock is provided", async () => {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({
          stream: "stdout",
          data: '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1}}',
        });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new UsageCapturingProcessRunner(inner).run({
      argv: ["claude", "-p", "--output-format", "json"],
      cwd: "/",
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });
    expect(result.usage?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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

  it("still parses a structured envelope that arrives after an oversized capture (trailing window, not discard-on-overflow)", async () => {
    // Regression for the old behavior, where exceeding MAX_STRUCTURED_ENVELOPE_BYTES cleared
    // `captured` and permanently stopped capturing for the rest of the run. The capture buffer
    // is now a bounded trailing window: it keeps appending and trims from the front, so a
    // terminal envelope that arrives after the cap is still within the retained window.
    const chunks: string[] = [];
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: "x".repeat(4 * 1024 * 1024 + 1) });
        options.onChunk({
          stream: "stdout",
          data: '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":9}}',
        });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["claude", "-p", "--output-format", "json"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: (chunk) => chunks.push(chunk.data),
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      signal: null,
      usage: { inputTokens: "9" },
    });
    // The oversized first chunk is still capped on the forwarding path (independent of
    // capture, which saw it whole above) — truncated data, then a marker chunk, then the
    // untouched envelope.
    expect(chunks).toHaveLength(3);
    expect(Buffer.byteLength(chunks[0]!, "utf8")).toBe(MAX_OUTPUT_CHUNK_BYTES);
    expect(chunks[1]).toBe(OUTPUT_CHUNK_TRUNCATION_MARKER);
    expect(chunks[2]).toBe(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":9}}',
    );
  });

  it("keeps the trailing window intact when the trim boundary bisects a multi-byte codepoint", async () => {
    // Regression for a follow-on bug in the trailing-window fix above: slicing a Buffer at a
    // fixed byte offset can land inside a multi-byte UTF-8 sequence. The orphaned bytes decode
    // to a U+FFFD (3 bytes in UTF-8) each, which can re-encode *longer* than the bytes they
    // replaced. MAX_STRUCTURED_ENVELOPE_BYTES is deliberately equal to jsonObject()'s own scan
    // cap with zero headroom, so if the trimmed window comes back even one byte over budget,
    // jsonObject() hard-rejects the whole thing and the envelope below is lost entirely.
    //
    // "€" is a 3-byte codepoint. Sized so the filler plus envelope lands 2 bytes over the cap,
    // the trim point falls 2 bytes into the first "€" — exactly the case a naive byte slice
    // gets wrong.
    const envelope =
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":"90"}}';
    const maxBytes = 4 * 1024 * 1024;
    const fillerBytes = maxBytes + 2 - Buffer.byteLength(envelope, "utf8");
    if (fillerBytes % 3 !== 0) throw new Error("test fixture must land the cut inside a codepoint");
    const filler = "€".repeat(fillerBytes / 3);
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: filler });
        options.onChunk({ stream: "stdout", data: envelope });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["claude", "-p", "--output-format", "json"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toMatchObject({ usage: { inputTokens: "90" } });
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

  // Same real sess-fa52d870 turn.failed fixture text as the "codex usage-limit detection"
  // describe block above, restated here since that block's consts are scoped to it.
  const turnFailedLine =
    '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 7:25 PM."}}';

  // Shared by the chunk-boundary/overflow cases below, which differ only in the chunks fed to
  // the PTY and (for the exit-0 usage case) the exit code — everything else about driving
  // UsageCapturingProcessRunner through the codex path is identical.
  function runCodexCapture(chunks: readonly string[], exitCode = 1): Promise<ProcessResult> {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        for (const data of chunks) options.onChunk({ stream: "stdout", data });
        return { exitCode, timedOut: false, signal: null };
      },
    };
    return new UsageCapturingProcessRunner(inner, () => observedAt).run({
      argv: ["codex", "exec", "--json"],
      cwd: "/",
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });
  }

  it("detects a codex usage-limit line split across two chunks at an arbitrary byte offset", async () => {
    // No trailing newline: codex's last line may not be newline-terminated, exercising
    // createCodexUsageStream's finish() flush of a non-empty pending fragment.
    const splitAt = 47; // arbitrary offset inside the JSON body
    await expect(
      runCodexCapture([turnFailedLine.slice(0, splitAt), turnFailedLine.slice(splitAt)]),
    ).resolves.toMatchObject({ usageLimit: true });
  });

  it("reassembles a codex record whose trailing \\r\\n is split exactly between chunks", async () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":5}}\r\n';
    const splitIndex = line.length - 1; // right after the "\r", right before the "\n"
    await expect(
      runCodexCapture([line.slice(0, splitIndex), line.slice(splitIndex)], 0),
    ).resolves.toMatchObject({ usage: { inputTokens: "5" } });
  });

  it("still detects a usage-limit line after codex output exceeds the old 4 MiB whole-envelope cap", async () => {
    // Before the fix, exceeding MAX_STRUCTURED_ENVELOPE_BYTES cleared `captured` and permanently
    // stopped capturing for codex, so a usage-limit line arriving after that point was lost.
    // Codex now folds JSONL incrementally per chunk with no whole-envelope cap at all.
    const noise = "noop diagnostic line, not JSON\n".repeat(45_000); // ~1.3 MiB per chunk
    await expect(
      runCodexCapture([noise, noise, noise, noise, `${turnFailedLine}\n`]),
    ).resolves.toMatchObject({ usageLimit: true });
  });

  it("drops an oversized unterminated codex line without throwing, then still detects a later valid line", async () => {
    const oversizedFragment = "x".repeat(CODEX_PENDING_LINE_MAX_BYTES + 1);
    await expect(
      runCodexCapture([oversizedFragment, `\n${turnFailedLine}\n`]),
    ).resolves.toMatchObject({ usageLimit: true });
  });

  it("skips a codex JSONL line that parses but is not an object", async () => {
    await expect(runCodexCapture([`[1,2,3]\n${turnFailedLine}\n`])).resolves.toMatchObject({
      usageLimit: true,
    });
  });

  it("does not capture codex output when structured JSON mode is not requested", async () => {
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: `${turnFailedLine}\n` });
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["codex", "exec"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: () => undefined,
      }),
    ).resolves.toEqual({ exitCode: 1, timedOut: false, signal: null });
  });

  it("detects a usage-limit line past the old 32 KiB single-chunk cutoff, while forwarding stays capped", async () => {
    // Regression for the root PR3 bug: a raw runner's own per-read truncation used to run
    // *before* capture ever saw the bytes, so a usage-limit record past the first 32 KiB of a
    // single oversized read was silently dropped. Capture must see the whole chunk regardless
    // of size; only the *forwarded* copy (to the real log/streamer) stays capped per chunk.
    const padding = "noop diagnostic line, not JSON\n".repeat(2_000);
    expect(Buffer.byteLength(padding, "utf8")).toBeGreaterThan(MAX_OUTPUT_CHUNK_BYTES);
    const singleOversizedChunk = `${padding}${turnFailedLine}\n`;
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: singleOversizedChunk });
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const forwarded: OutputChunk[] = [];
    await expect(
      new UsageCapturingProcessRunner(inner, () => observedAt).run({
        argv: ["codex", "exec", "--json"],
        cwd: "/",
        timeoutMs: 1_000,
        onChunk: (chunk) => forwarded.push(chunk),
      }),
    ).resolves.toMatchObject({ usageLimit: true });
    expect(forwarded.length).toBeGreaterThan(1);
    for (const chunk of forwarded) {
      expect(Buffer.byteLength(chunk.data, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_CHUNK_BYTES);
    }
    expect(forwarded.some((chunk) => chunk.data === OUTPUT_CHUNK_TRUNCATION_MARKER)).toBe(true);
  });

  it("does not double-mark a chunk the inner runner already truncated", async () => {
    // UsageCapturingProcessRunner's forward-capping step must be a no-op when `this.inner`
    // already enforces the same cap (e.g. wrapping a default, non-opted-in PtyProcessRunner,
    // or SpawnProcessRunner) — no second marker, and the marker chunk itself passes through.
    const inner: ProcessRunner = {
      async run(options: RunProcessOptions): Promise<ProcessResult> {
        options.onChunk({ stream: "stdout", data: "x".repeat(MAX_OUTPUT_CHUNK_BYTES) });
        options.onChunk({ stream: "stdout", data: OUTPUT_CHUNK_TRUNCATION_MARKER });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const forwarded: OutputChunk[] = [];
    await new UsageCapturingProcessRunner(inner, () => observedAt).run({
      argv: ["echo"],
      cwd: "/",
      timeoutMs: 1_000,
      onChunk: (chunk) => forwarded.push(chunk),
    });
    expect(forwarded).toEqual([
      { stream: "stdout", data: "x".repeat(MAX_OUTPUT_CHUNK_BYTES) },
      { stream: "stdout", data: OUTPUT_CHUNK_TRUNCATION_MARKER },
    ]);
  });
});

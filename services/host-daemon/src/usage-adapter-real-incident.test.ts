import { describe, expect, it } from "vitest";

import { parseCliUsage, resolveCliProvider } from "./usage-adapter.ts";
import { detectUsageLimit } from "./usage-limit.ts";

const observedAt = "2026-09-19T00:00:00.000Z";
const PROMPT = "Reply with exactly: hello world. Do not use any tools.";

/**
 * Pins the full `parseCliUsage` + `detectUsageLimit` pipeline (not just the adapter in
 * isolation) against real CLI output captured 2026-09-19 from two agent CLIs genuinely out
 * of usage, each run with its exact catalog preset argv
 * (services/web/src/lib/catalog-command-defaults.ts) inside a git repo. Random per-run ids
 * (thread/session/request ids) are replaced with placeholders; every message sentence is
 * kept byte-for-byte verbatim.
 */
describe("real capture 2026-09-19: grok 1.0.30 out of usage (402)", () => {
  const argv = [
    "grok",
    "--always-approve",
    "--max-turns",
    "3",
    "--output-format",
    "json",
    "-p",
    PROMPT,
  ];
  // The daemon captures stdout and stderr into one merged buffer regardless of which stream
  // each chunk arrived on (see UsageCapturingProcessRunner.run's onChunk) — this is stdout's
  // JSON envelope followed by stderr's plain-text re-print of the same failure, exactly as a
  // real run hands them to parseCliUsage. Concatenated, this is byte-identical to the #441
  // incident fixture already pinned in usage-adapter.test.ts ("finds grok's real usage-limit
  // envelope even when a later re-print also parses as JSON") — grok's 402 envelope text has
  // not drifted since that incident. The new coverage here is running it through the full
  // daemon pipeline (parseCliUsage feeding detectUsageLimit), not just the adapter in isolation.
  const stdout =
    JSON.stringify({
      type: "error",
      message:
        'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
    }) +
    "\n" +
    'Error: Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}\n';

  it("classifies as a usage limit through parseCliUsage + detectUsageLimit together", () => {
    const parsed = parseCliUsage({ argv, output: stdout, observedAt });
    expect(parsed).toEqual({ usageLimit: true });
    expect(
      detectUsageLimit({
        argv,
        failed: true,
        providerAccountId: "acct-grok-1",
        adapterUsageLimit: parsed.usageLimit,
      }),
    ).toBe("adapter");
  });

  it("never classifies on a success exit, even given the same output", () => {
    const parsed = parseCliUsage({ argv, output: stdout, observedAt });
    expect(
      detectUsageLimit({
        argv,
        failed: false,
        providerAccountId: "acct-grok-1",
        adapterUsageLimit: parsed.usageLimit,
      }),
    ).toBeUndefined();
  });
});

describe("real capture 2026-09-19: codex-cli 0.154.0 out of usage (turn.failed)", () => {
  const argv = ["codex", "exec", "--json", "--", PROMPT];
  // Same sentence pattern as the pinned sess-fa52d870 fixture in usage-adapter.test.ts (only
  // the embedded retry date differs — this account's cooldown reported "Sep 19th, 2026 1:15
  // AM"). The new coverage here is the *actual* multi-record session shape a real `codex exec
  // --json` run emits (thread.started + turn.started + error + turn.failed together) fed
  // through parseCliUsage and then detectUsageLimit, not an isolated single-line fixture.
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "<redacted-thread-id>" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "error",
      message:
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 1:15 AM.",
    }),
    JSON.stringify({
      type: "turn.failed",
      error: {
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 19th, 2026 1:15 AM.",
      },
    }),
  ].join("\n");

  it("classifies as a usage limit through parseCliUsage + detectUsageLimit together", () => {
    const parsed = parseCliUsage({ argv, output: stdout, observedAt });
    expect(parsed).toEqual({ usageLimit: true });
    expect(
      detectUsageLimit({
        argv,
        failed: true,
        providerAccountId: "acct-codex-1",
        adapterUsageLimit: parsed.usageLimit,
      }),
    ).toBe("adapter");
  });

  it("never classifies on a success exit, even given the same output", () => {
    const parsed = parseCliUsage({ argv, output: stdout, observedAt });
    expect(
      detectUsageLimit({
        argv,
        failed: false,
        providerAccountId: "acct-codex-1",
        adapterUsageLimit: parsed.usageLimit,
      }),
    ).toBeUndefined();
  });
});

describe("real capture 2026-09-19: cursor-agent success", () => {
  // Real output from cursor-agent 2026.09.10-fd3934a. The account still had usage when this
  // was captured, so the exhausted-account envelope is intentionally covered separately once
  // it can be captured rather than inferred from model-authored text or another provider.
  const argv = ["cursor-agent", "--print", "--force", "--output-format", "json", "--", PROMPT];
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5219,
    duration_api_ms: 5219,
    result: "hello world",
    session_id: "<redacted-session-id>",
    request_id: "<redacted-request-id>",
    usage: { inputTokens: 14615, outputTokens: 26, cacheReadTokens: 4352, cacheWriteTokens: 0 },
  });

  it("records the real token fields and provider-authored summary", () => {
    expect(resolveCliProvider(argv)).toBe("cursor");
    expect(parseCliUsage({ argv, output: stdout, observedAt })).toEqual({
      agentSummary: "hello world",
      usage: {
        kind: "cumulative",
        sequence: 0,
        source: "cli",
        observedAt,
        inputTokens: "14615",
        outputTokens: "26",
        cachedInputTokens: "4352",
      },
    });
  });
});

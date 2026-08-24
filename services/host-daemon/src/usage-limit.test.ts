import { describe, expect, it } from "vitest";

import { detectUsageLimit } from "./usage-limit.ts";

type Match = ReturnType<typeof detectUsageLimit>;

type Case = {
  argv: readonly string[];
  output: string;
  failed?: boolean;
  adapterUsageLimit?: boolean;
  providerAccountId?: string;
  expected: Match;
};

function classify(row: Case): Match {
  return detectUsageLimit({
    argv: row.argv,
    failed: row.failed ?? true,
    output: row.output,
    providerAccountId: row.providerAccountId ?? "acct-1",
    ...(row.adapterUsageLimit !== undefined ? { adapterUsageLimit: row.adapterUsageLimit } : {}),
  });
}

describe("detectUsageLimit", () => {
  it("requires trusted provider identity and a failure signal", () => {
    const cases: Case[] = [
      {
        argv: ["codex", "exec"],
        failed: false,
        output: "insufficient_quota\nRate limit reached for model",
        expected: undefined,
      },
      {
        argv: ["echo"],
        output: "Error: usage limit exceeded\nHTTP 429 Too Many Requests",
        expected: undefined,
      },
      { argv: ["usage"], output: "insufficient_quota", expected: undefined },
      { argv: ["npx", "claude"], output: "quota exceeded", expected: undefined },
      { argv: [], output: "rate limit", expected: undefined },
      { argv: [""], output: "rate limit", expected: undefined },
      { argv: ["claude", "-p"], output: "", expected: undefined },
      { argv: ["codex"], output: "all tests passed", expected: undefined },
      { argv: ["codex"], output: "rate limit\nHTTP 429 Too Many Requests", expected: undefined },
      { argv: ["codex"], output: "rate_limit_error\nRESOURCE_EXHAUSTED", expected: undefined },
      { argv: ["claude"], output: "insufficient_quota\nquota exceeded", expected: undefined },
      { argv: ["gemini"], output: "rate_limit_error\nrate limit reached", expected: undefined },
      { argv: ["grok"], output: "insufficient_quota\nToo Many Requests", expected: undefined },
      {
        argv: ["codex"],
        providerAccountId: "",
        output: "insufficient_quota",
        expected: undefined,
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });

  it("classifies provider-specific vendor limit text on failed runs", () => {
    const cases: Case[] = [
      {
        argv: ["/usr/local/bin/codex", "exec"],
        output: "Error: insufficient_quota for request",
        expected: "output",
      },
      {
        argv: ["C:\\Program Files\\codex.exe"],
        output: "You exceeded your current quota, please check your plan",
        expected: "output",
      },
      { argv: ["codex.cmd"], output: "Rate limit reached for gpt-5", expected: "output" },
      {
        argv: ["codex"],
        output: "You've hit your usage limit. Try again later.",
        expected: "output",
      },
      {
        argv: ["claude", "-p"],
        output: '{"type":"error","error":{"type":"rate_limit_error"}}',
        expected: "output",
      },
      {
        argv: ["/opt/homebrew/bin/claude"],
        output: "Claude AI usage limit reached|1755615600",
        expected: "output",
      },
      { argv: ["claude"], output: "You've hit your limit. Reset at 5pm.", expected: "output" },
      { argv: ["claude"], output: "Claude usage limit reached.", expected: "output" },
      { argv: ["claude"], output: "You have hit your monthly limit", expected: "output" },
      { argv: ["claude"], output: "You've hit your session limit", expected: "output" },
      { argv: ["claude"], output: "You've hit your weekly limit", expected: "output" },
      { argv: ["claude"], output: "You've hit your Opus limit", expected: "output" },
      { argv: ["gemini"], output: '{"error":{"status":"RESOURCE_EXHAUSTED"}}', expected: "output" },
      {
        argv: ["gemini"],
        output: "Resource has been exhausted (e.g. check quota).",
        expected: "output",
      },
      {
        argv: ["gemini"],
        output: "You exceeded your current quota, please check your plan.",
        expected: "output",
      },
      {
        argv: ["gemini.bat"],
        output: "Quota exceeded for quota metric: generate_content_free_tier_requests",
        expected: "output",
      },
      {
        argv: ["gemini"],
        output: "Quota exceeded for metric: generate_content_requests",
        expected: "output",
      },
      {
        argv: ["grok", "-p"],
        output: "Rate limit error: team limits exceeded",
        expected: "output",
      },
      { argv: ["grok"], output: "You've reached your usage limit", expected: "output" },
      { argv: ["grok"], output: "usage limits exceeded for this account", expected: "output" },
      { argv: ["grok.cmd"], output: "You have reached your rate limit", expected: "output" },
      { argv: ["grok"], output: "usage limit hit", expected: "output" },
      {
        argv: ["grok"],
        output: "You've reached your free Grok Build usage limit for now.",
        expected: "output",
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });

  it("accepts a trusted adapter flag only with known provider context and failure", () => {
    const cases: Case[] = [
      { argv: ["codex", "exec"], adapterUsageLimit: true, output: "", expected: "adapter" },
      {
        argv: ["codex"],
        adapterUsageLimit: true,
        output: "command failed",
        expected: "adapter",
      },
      {
        argv: ["codex"],
        adapterUsageLimit: true,
        output: "insufficient_quota",
        expected: "output",
      },
      {
        argv: ["echo"],
        adapterUsageLimit: true,
        output: "insufficient_quota",
        expected: undefined,
      },
      {
        argv: ["codex"],
        failed: false,
        adapterUsageLimit: true,
        output: "insufficient_quota",
        expected: undefined,
      },
      {
        argv: ["codex"],
        adapterUsageLimit: false,
        output: "insufficient_quota",
        expected: "output",
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });
});

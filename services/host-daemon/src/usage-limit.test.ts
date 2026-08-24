import { describe, expect, it } from "vitest";

import { detectUsageLimit } from "./usage-limit.ts";

type Case = {
  argv: readonly string[];
  output: string;
  failed?: boolean;
  adapterUsageLimit?: boolean;
  expected: boolean;
};

function classify(row: Case): boolean {
  return detectUsageLimit({
    argv: row.argv,
    failed: row.failed ?? true,
    output: row.output,
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
        expected: false,
      },
      {
        argv: ["echo"],
        output: "Error: usage limit exceeded\nHTTP 429 Too Many Requests",
        expected: false,
      },
      { argv: ["usage"], output: "insufficient_quota", expected: false },
      { argv: ["npx", "claude"], output: "quota exceeded", expected: false },
      { argv: [], output: "rate limit", expected: false },
      { argv: [""], output: "rate limit", expected: false },
      { argv: ["claude", "-p"], output: "", expected: false },
      { argv: ["codex"], output: "all tests passed", expected: false },
      { argv: ["codex"], output: "rate limit\nHTTP 429 Too Many Requests", expected: false },
      { argv: ["codex"], output: "rate_limit_error\nRESOURCE_EXHAUSTED", expected: false },
      { argv: ["claude"], output: "insufficient_quota\nquota exceeded", expected: false },
      { argv: ["gemini"], output: "rate_limit_error\nrate limit reached", expected: false },
      { argv: ["grok"], output: "insufficient_quota\nToo Many Requests", expected: false },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });

  it("classifies provider-specific vendor limit text on failed runs", () => {
    const cases: Case[] = [
      {
        argv: ["/usr/local/bin/codex", "exec"],
        output: "Error: insufficient_quota for request",
        expected: true,
      },
      {
        argv: ["C:\\Program Files\\codex.exe"],
        output: "You exceeded your current quota, please check your plan",
        expected: true,
      },
      { argv: ["codex.cmd"], output: "Rate limit reached for gpt-5", expected: true },
      { argv: ["codex"], output: "You've hit your usage limit. Try again later.", expected: true },
      {
        argv: ["claude", "-p"],
        output: '{"type":"error","error":{"type":"rate_limit_error"}}',
        expected: true,
      },
      {
        argv: ["/opt/homebrew/bin/claude"],
        output: "Claude AI usage limit reached|1755615600",
        expected: true,
      },
      { argv: ["claude"], output: "You've hit your limit. Reset at 5pm.", expected: true },
      { argv: ["claude"], output: "Claude usage limit reached.", expected: true },
      { argv: ["claude"], output: "You have hit your monthly limit", expected: true },
      { argv: ["claude"], output: "You've hit your session limit", expected: true },
      { argv: ["claude"], output: "You've hit your weekly limit", expected: true },
      { argv: ["claude"], output: "You've hit your Opus limit", expected: true },
      { argv: ["gemini"], output: '{"error":{"status":"RESOURCE_EXHAUSTED"}}', expected: true },
      {
        argv: ["gemini"],
        output: "Resource has been exhausted (e.g. check quota).",
        expected: true,
      },
      {
        argv: ["gemini"],
        output: "You exceeded your current quota, please check your plan.",
        expected: true,
      },
      {
        argv: ["gemini.bat"],
        output: "Quota exceeded for quota metric: generate_content_free_tier_requests",
        expected: true,
      },
      {
        argv: ["gemini"],
        output: "Quota exceeded for metric: generate_content_requests",
        expected: true,
      },
      { argv: ["grok", "-p"], output: "Rate limit error: team limits exceeded", expected: true },
      { argv: ["grok"], output: "You've reached your usage limit", expected: true },
      { argv: ["grok"], output: "usage limits exceeded for this account", expected: true },
      { argv: ["grok.cmd"], output: "You have reached your rate limit", expected: true },
      { argv: ["grok"], output: "usage limit hit", expected: true },
      {
        argv: ["grok"],
        output: "You've reached your free Grok Build usage limit for now.",
        expected: true,
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });

  it("accepts a trusted adapter flag only with known provider context and failure", () => {
    const cases: Case[] = [
      { argv: ["codex", "exec"], adapterUsageLimit: true, output: "", expected: true },
      { argv: ["echo"], adapterUsageLimit: true, output: "insufficient_quota", expected: false },
      {
        argv: ["codex"],
        failed: false,
        adapterUsageLimit: true,
        output: "insufficient_quota",
        expected: false,
      },
      { argv: ["codex"], adapterUsageLimit: false, output: "insufficient_quota", expected: true },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });
});

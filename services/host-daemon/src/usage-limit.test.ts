import { describe, expect, it } from "vitest";

import { detectUsageLimit } from "./usage-limit.ts";

type Match = ReturnType<typeof detectUsageLimit>;

type Case = {
  argv: readonly string[];
  failed?: boolean;
  adapterUsageLimit?: boolean;
  providerAccountId?: string;
  expected: Match;
};

function classify(row: Case): Match {
  return detectUsageLimit({
    argv: row.argv,
    failed: row.failed ?? true,
    providerAccountId: row.providerAccountId ?? "acct-1",
    ...(row.adapterUsageLimit !== undefined ? { adapterUsageLimit: row.adapterUsageLimit } : {}),
  });
}

describe("detectUsageLimit", () => {
  it("rejects all raw output, including provider-shaped quota text", () => {
    const cases: Case[] = [
      {
        argv: ["codex", "exec"],
        failed: false,
        expected: undefined,
      },
      {
        argv: ["echo"],
        expected: undefined,
      },
      { argv: ["usage"], expected: undefined },
      { argv: ["npx", "claude"], expected: undefined },
      { argv: [], expected: undefined },
      { argv: [""], expected: undefined },
      { argv: ["claude", "-p"], expected: undefined },
      { argv: ["codex"], expected: undefined },
      { argv: ["gemini"], expected: undefined },
      { argv: ["grok"], expected: undefined },
      {
        argv: ["codex"],
        providerAccountId: "",
        expected: undefined,
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });

  it("accepts a trusted adapter flag only with known provider context and failure", () => {
    const cases: Case[] = [
      { argv: ["codex", "exec"], adapterUsageLimit: true, expected: "adapter" },
      {
        argv: ["codex"],
        adapterUsageLimit: true,
        expected: "adapter",
      },
      {
        argv: ["codex"],
        adapterUsageLimit: true,
        expected: "adapter",
      },
      {
        argv: ["echo"],
        adapterUsageLimit: true,
        expected: undefined,
      },
      {
        argv: ["codex"],
        failed: false,
        adapterUsageLimit: true,
        expected: undefined,
      },
      {
        argv: ["codex"],
        adapterUsageLimit: false,
        expected: undefined,
      },
    ];
    for (const row of cases) expect(classify(row), JSON.stringify(row)).toBe(row.expected);
  });
});

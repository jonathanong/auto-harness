import { describe, expect, it } from "vitest";

import { configuredCost, hasReportedUsage, type UsageAggregate } from "./session-usage-summary.ts";

const aggregate: UsageAggregate = {
  reportCount: 1,
  inputTokens: "2",
  outputTokens: "3",
  totalTokens: "5",
  costMicros: "4",
  costMicrosByCurrency: { USD: "4" },
  currency: "USD",
};

describe("session usage summary", () => {
  it("recognizes empty aggregates as having no CLI report", () => {
    expect(hasReportedUsage(null)).toBe(false);
    expect(hasReportedUsage({ ...aggregate, reportCount: 0 })).toBe(false);
    expect(hasReportedUsage(aggregate)).toBe(true);
  });

  it("renders mixed configured costs by currency", () => {
    expect(configuredCost(aggregate)).toBe("4 USD micros");
    expect(
      configuredCost({
        ...aggregate,
        costMicros: "0",
        currency: undefined,
        costMicrosByCurrency: { USD: "4", EUR: "6" },
      }),
    ).toBe("4 USD micros, 6 EUR micros");
  });
});

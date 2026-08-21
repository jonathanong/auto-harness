import { describe, expect, it } from "vitest";

import { describeCron, routeLabel } from "./schedule-cron-label.ts";

describe("describeCron", () => {
  it("describes minute intervals and hourly schedules", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/1 * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("0 * * * *")).toBe("Every hour");
    expect(describeCron("30 * * * *")).toBe("Every hour at minute 30");
  });

  it("describes fixed daily times", () => {
    expect(describeCron("0 6 * * *")).toBe("Every day at 6:00 AM UTC");
    expect(describeCron("5 0 * * *")).toBe("Every day at 12:05 AM UTC");
    expect(describeCron("30 12 * * *")).toBe("Every day at 12:30 PM UTC");
  });

  it("describes simple weekly and monthly schedules", () => {
    expect(describeCron("30 18 * * 1")).toBe("Every Monday at 6:30 PM UTC");
    expect(describeCron("5 0 1 * *")).toBe("Every month on day 1 at 12:05 AM UTC");
  });

  it("labels unsupported or out-of-range expressions as custom", () => {
    for (const expression of [
      "0 0 * 1 *",
      "*/60 * * * *",
      "*/40 * * * *",
      "60 * * * *",
      "0 0 * * 7",
      "0 0 0 * *",
      "0 0 32 * *",
      "60 0 * * *",
      "0 24 * * *",
    ]) {
      expect(describeCron(expression)).toBe("Custom schedule");
    }
  });
});

describe("routeLabel", () => {
  it("labels provider and command targets", () => {
    expect(routeLabel(undefined)).toBeNull();
    expect(routeLabel(null)).toBeNull();
    expect(routeLabel({})).toBeNull();
    expect(routeLabel({ providerId: "p-1" })).toBe("provider:p-1");
    expect(routeLabel({ commandId: "c-1" })).toBe("command:c-1");
  });
});

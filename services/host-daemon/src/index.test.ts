import { describe, expect, it } from "vitest";

import { detectUsageLimit, getServiceName, parseCliUsage, serviceName } from "./index.ts";

describe("@auto-harness/host-daemon", () => {
  it("exports package identity and core helpers", () => {
    expect(serviceName).toBe("@auto-harness/host-daemon");
    expect(getServiceName()).toBe(serviceName);
    expect(
      detectUsageLimit({
        argv: ["codex"],
        failed: true,
        providerAccountId: "acct-1",
        adapterUsageLimit: true,
      }),
    ).toBe("adapter");
    expect(
      parseCliUsage({
        argv: ["echo"],
        output: "{}",
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({});
  });
});

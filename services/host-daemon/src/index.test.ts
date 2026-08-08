import { describe, expect, it } from "vitest";

import { detectUsageLimit, getServiceName, resolveCommandArgv, serviceName } from "./index.ts";

describe("@auto-harness/host-daemon", () => {
  it("exports package identity and core helpers", () => {
    expect(serviceName).toBe("@auto-harness/host-daemon");
    expect(getServiceName()).toBe(serviceName);
    expect(detectUsageLimit("quota exceeded")).toBe(true);
    expect(resolveCommandArgv({ p: { argv: ["echo"], appendPrompt: true } }, "p", "x")).toEqual([
      "echo",
      "x",
    ]);
  });
});

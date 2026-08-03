import { describe, expect, it } from "vitest";

import { detectUsageLimit, getServiceName, resolveCommandArgv, serviceName } from "./index.ts";

describe("@auto-harness/agent", () => {
  it("exports package identity and core helpers", () => {
    expect(serviceName).toBe("@auto-harness/agent");
    expect(getServiceName()).toBe(serviceName);
    expect(detectUsageLimit("quota exceeded")).toBe(true);
    expect(resolveCommandArgv({ p: { argv: ["echo"], appendPrompt: true } }, "p", "x")).toEqual([
      "echo",
      "x",
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.js";

describe("@auto-harness/agent", () => {
  it("exports package identity", () => {
    expect(serviceName).toBe("@auto-harness/agent");
    expect(getServiceName()).toBe(serviceName);
  });
});

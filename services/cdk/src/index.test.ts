import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.js";

describe("@auto-harness/cdk", () => {
  it("exports package identity", () => {
    expect(serviceName).toBe("@auto-harness/cdk");
    expect(getServiceName()).toBe(serviceName);
  });
});

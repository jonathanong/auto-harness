import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.js";

describe("@auto-harness/api", () => {
  it("exports package identity", () => {
    expect(serviceName).toBe("@auto-harness/api");
    expect(getServiceName()).toBe(serviceName);
  });
});

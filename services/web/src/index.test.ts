import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.ts";

describe("@auto-harness/web", () => {
  it("exports package identity", () => {
    expect(serviceName).toBe("@auto-harness/web");
    expect(getServiceName()).toBe(serviceName);
  });
});

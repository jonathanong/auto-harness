import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.ts";

describe("agent-web package", () => {
  it("exports service name", () => {
    expect(serviceName).toContain("agent-web");
    expect(getServiceName()).toBe(serviceName);
  });
});

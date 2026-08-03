import { describe, expect, it } from "vitest";

import { getServiceName, serviceName } from "./index.ts";

describe("web package", () => {
  it("exports service name", () => {
    expect(serviceName).toContain("web");
    expect(getServiceName()).toBe(serviceName);
  });
});

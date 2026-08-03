import { describe, expect, it } from "vitest";

import { createLocalApp, getServiceName, MemorySessionStore, serviceName } from "./index.ts";

describe("@auto-harness/api", () => {
  it("exports package identity and local server helpers", () => {
    expect(serviceName).toBe("@auto-harness/api");
    expect(getServiceName()).toBe(serviceName);
    expect(typeof createLocalApp).toBe("function");
    expect(new MemorySessionStore().list()).toEqual([]);
  });
});

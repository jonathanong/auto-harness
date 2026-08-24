import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("provider account maxConcurrentSessions", () => {
  it("defaults to 1 and rejects an invalid cap", () => {
    const plane = new ControlPlane({
      providerAccountIdFactory: () => "acct-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.createProvider({ id: "prov-1", name: "claude" });
    const created = plane.createProviderAccount({ providerId: "prov-1", label: "x@y.com" });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.account.maxConcurrentSessions).toBe(1);
    expect(
      plane.createProviderAccount({
        id: "acct-bad",
        providerId: "prov-1",
        label: "cap",
        maxConcurrentSessions: 0,
      }).ok,
    ).toBe(false);
    expect(plane.updateProviderAccount("acct-1", { maxConcurrentSessions: 3 }).ok).toBe(true);
    expect(plane.getProviderAccount("acct-1")?.maxConcurrentSessions).toBe(3);
    expect(plane.updateProviderAccount("acct-1", { maxConcurrentSessions: 99 }).ok).toBe(false);
  });
});

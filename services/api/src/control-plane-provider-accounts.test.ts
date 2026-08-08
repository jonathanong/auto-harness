import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("ControlPlane provider account CRUD", () => {
  it("validates, creates, lists, updates, and deletes provider accounts", () => {
    let n = 0;
    const plane = new ControlPlane({
      providerAccountIdFactory: () => `acct-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.createProvider({ id: "prov-1", name: "claude" });
    plane.createProvider({ id: "prov-2", name: "codex" });

    expect(plane.createProviderAccount({ providerId: "", label: "" }).ok).toBe(false);
    expect(plane.createProviderAccount({ providerId: "missing", label: "x@y.com" }).ok).toBe(false);

    const acct = plane.createProviderAccount({ providerId: "prov-1", label: "x@y.com" });
    expect(acct.ok).toBe(true);
    if (!acct.ok) {
      throw new Error("unreachable");
    }
    expect(acct.account).toMatchObject({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });

    expect(plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "z" }).ok).toBe(
      false,
    );

    expect(plane.getProviderAccount("acct-1")?.label).toBe("x@y.com");
    expect(plane.getProviderAccount("missing")).toBeNull();
    expect(plane.listProviderAccounts().map((a) => a.label)).toEqual(["x@y.com"]);

    expect(plane.updateProviderAccount("missing", { label: "x" }).ok).toBe(false);
    expect(plane.updateProviderAccount("acct-1", { providerId: "missing" }).ok).toBe(false);
    const updated = plane.updateProviderAccount("acct-1", {
      providerId: "prov-2",
      label: "y@z.com",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.account).toMatchObject({ providerId: "prov-2", label: "y@z.com" });
    }

    expect(plane.deleteProviderAccount("missing").ok).toBe(false);
    expect(plane.deleteProviderAccount("acct-1").ok).toBe(true);
    expect(plane.getProviderAccount("acct-1")).toBeNull();
  });
});

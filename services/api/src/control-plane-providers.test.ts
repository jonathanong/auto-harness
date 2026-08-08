import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("ControlPlane provider CRUD", () => {
  it("validates, creates, lists, updates, and deletes providers", () => {
    let n = 0;
    const plane = new ControlPlane({
      providerIdFactory: () => `prov-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect(plane.createProvider({ name: "" }).ok).toBe(false);
    expect(plane.createProvider({ name: "Claude" }).ok).toBe(false); // not a slug

    const claude = plane.createProvider({ name: "claude" });
    expect(claude.ok).toBe(true);
    if (!claude.ok) {
      throw new Error("unreachable");
    }
    expect(claude.provider).toMatchObject({ id: "prov-1", name: "claude", defaultCommandId: null });

    expect(plane.createProvider({ name: "claude" }).ok).toBe(false); // duplicate name
    expect(plane.createProvider({ id: "prov-1", name: "codex" }).ok).toBe(false); // duplicate id

    const codex = plane.createProvider({ name: "codex", defaultCommandId: "cmd-1" });
    expect(codex.ok).toBe(true);

    expect(plane.getProvider("prov-1")?.name).toBe("claude");
    expect(plane.getProvider("missing")).toBeNull();
    expect(plane.listProviders().map((p) => p.name)).toEqual(["claude", "codex"]);

    expect(plane.updateProvider("missing", { name: "x" }).ok).toBe(false);
    expect(plane.updateProvider("prov-1", { name: "Bad Name" }).ok).toBe(false);
    if (codex.ok) {
      expect(plane.updateProvider("prov-1", { name: codex.provider.name }).ok).toBe(false);
    }
    const updated = plane.updateProvider("prov-1", { name: "claude2", defaultCommandId: "cmd-2" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.provider).toMatchObject({ name: "claude2", defaultCommandId: "cmd-2" });
    }

    expect(plane.deleteProvider("missing").ok).toBe(false);
    expect(plane.deleteProvider("prov-1").ok).toBe(true);
    expect(plane.getProvider("prov-1")).toBeNull();
  });

  it("blocks deleting a provider with attached accounts or commands", () => {
    const plane = new ControlPlane({ now: () => "t" });
    const provider = plane.createProvider({ id: "p1", name: "claude" });
    expect(provider.ok).toBe(true);

    plane.createProviderAccount({ id: "a1", providerId: "p1", label: "x@y.com" });
    expect(plane.deleteProvider("p1").ok).toBe(false);
    plane.deleteProviderAccount("a1");
    expect(plane.deleteProvider("p1").ok).toBe(true);

    plane.createProvider({ id: "p2", name: "codex" });
    plane.createCommand({
      id: "c1",
      name: "codex exec",
      argv: ["codex", "exec"],
      providerId: "p2",
    });
    expect(plane.deleteProvider("p2").ok).toBe(false);
    plane.deleteCommand("c1");
    expect(plane.deleteProvider("p2").ok).toBe(true);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { apiGet } from "./api-client.ts";
import { inventoryHasExecConfig, reconcileInventoryWrite } from "./host-exec-config.ts";
import { emptyHostInventory } from "./host-inventory.ts";
import { isValidGitHubIngressDefaultRef } from "./scheduled-branch-ref.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuration boundaries", () => {
  it.each([
    ["ws://control.example.test/ws", "http://control.example.test/api/v1/hosts"],
    ["wss://control.example.test/ws/", "https://control.example.test/api/v1/hosts"],
  ])("fetches over HTTP when configured with WebSocket endpoint %s", async (endpoint, expected) => {
    vi.stubEnv("HARNESS_API_HTTP", endpoint);
    const request = vi.fn(async (input: string | URL) => {
      expect(String(input)).toBe(expected);
      return new Response(JSON.stringify({ hosts: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    await expect(apiGet("/api/v1/hosts")).resolves.toEqual({ hosts: [] });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves host setup-cache inputs on an ordinary inventory write and fences edits", () => {
    const existing = { ...emptyHostInventory(), setupCacheInputs: ["package.json"] };
    expect(inventoryHasExecConfig(existing)).toBe(true);

    const ordinary = reconcileInventoryWrite({
      existing,
      incoming: emptyHostInventory(),
      allowExecConfig: false,
    });
    expect(ordinary).toMatchObject({ ok: true, execEdits: [] });
    if (!ordinary.ok) throw new Error("ordinary inventory write rejected");
    expect(ordinary.inventory.setupCacheInputs).toEqual(["package.json"]);
    expect(ordinary.inventory.setupCacheInputs).not.toBe(existing.setupCacheInputs);

    const changed = reconcileInventoryWrite({
      existing,
      incoming: { ...emptyHostInventory(), setupCacheInputs: ["pnpm-lock.yaml"] },
      allowExecConfig: false,
    });
    expect(changed).toMatchObject({
      ok: false,
      kind: "forbidden",
      execEdits: ["setupCacheInputs"],
    });

    const authorized = reconcileInventoryWrite({
      existing,
      incoming: { ...emptyHostInventory(), setupCacheInputs: ["pnpm-lock.yaml"] },
      allowExecConfig: true,
    });
    expect(authorized).toMatchObject({ ok: true, execEdits: ["setupCacheInputs"] });
    if (!authorized.ok) throw new Error("authorized cache-input edit rejected");
    expect(authorized.inventory.setupCacheInputs).toEqual(["pnpm-lock.yaml"]);
  });

  it("bounds canonical GitHub default refs by UTF-8 bytes", () => {
    expect(isValidGitHubIngressDefaultRef(`refs/heads/${"é".repeat(122)}`)).toBe(true);
    expect(isValidGitHubIngressDefaultRef(`refs/heads/${"é".repeat(123)}`)).toBe(false);
  });
});

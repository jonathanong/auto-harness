import { describe, expect, it, vi } from "vitest";

import {
  emptyDaemonConfig,
  fetchHostInventory,
  HostInventoryPolicyError,
  httpBaseFromApiUrl,
  inventoryFingerprint,
} from "./bootstrap.ts";
import { valid } from "./config-test-helpers.ts";

describe("httpBaseFromApiUrl", () => {
  it("normalizes http, https, ws, wss and trailing /ws", () => {
    expect(httpBaseFromApiUrl("http://127.0.0.1:7420/")).toBe("http://127.0.0.1:7420");
    expect(httpBaseFromApiUrl("https://api.example/ws")).toBe("https://api.example");
    expect(httpBaseFromApiUrl("ws://127.0.0.1:7420/ws")).toBe("http://127.0.0.1:7420");
    expect(httpBaseFromApiUrl("wss://api.example/ws/")).toBe("https://api.example");
  });
});

describe("fetchHostInventory", () => {
  it("labels both Error and primitive root-policy failures", () => {
    expect(() => {
      throw new HostInventoryPolicyError(new Error("outside root"));
    }).toThrow("outside root");
    expect(new HostInventoryPolicyError("outside root").message).toContain("outside root");
    expect(new HostInventoryPolicyError("outside root", ["/safe"]).allowedRoots).toEqual(["/safe"]);
  });

  it("maps identity and host inventory", async () => {
    const fetchFn = vi.fn(async () => Response.json({ repositories: valid.repositories }));
    const config = await fetchHostInventory(
      { hostId: "local-1", apiUrl: "ws://127.0.0.1:7420/ws", apiKey: "hns_x" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(config.hostId).toBe("local-1");
    expect(config.apiUrl).toBe("ws://127.0.0.1:7420/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.repositories[0]?.id).toBe("repo-1");
  });

  it("returns empty inventory when host config is not yet set (404)", async () => {
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    const config = await fetchHostInventory(
      { hostId: "a", apiUrl: "http://127.0.0.1:7420" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(config.hostId).toBe("a");
    expect(config.repositories).toEqual([]);
  });

  it("emptyDaemonConfig and inventoryFingerprint", () => {
    const empty = emptyDaemonConfig({ hostId: "a", apiUrl: "http://x", apiKey: "k" });
    expect(empty.repositories).toEqual([]);
    expect(empty.apiKey).toBe("k");
    // Stable for identical repositories, and reflects repository content.
    expect(inventoryFingerprint(empty)).toBe(
      inventoryFingerprint({ hostId: "a", repositories: [], providerAccounts: [] }),
    );
    expect(inventoryFingerprint(empty)).not.toBe(
      inventoryFingerprint({
        ...empty,
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
      }),
    );
    expect(inventoryFingerprint(empty)).not.toBe(
      inventoryFingerprint({ ...empty, setupScript: "source ~/.zshrc" }),
    );
  });

  it("handles empty error bodies", async () => {
    const fetchFn = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        statusText: "err",
        text: async () => {
          throw new Error("no body");
        },
      } as unknown as Response;
    });
    await expect(
      fetchHostInventory(
        { hostId: "a", apiUrl: "http://x" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/bootstrap failed \(500\).*err/);
  });

  it("rejects a primitive inventory body", async () => {
    const fetchFn = vi.fn(async () => Response.json("not-an-inventory"));
    await expect(
      fetchHostInventory(
        { hostId: "a", apiUrl: "http://x" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow("config root must be an object");
    expect(fetchFn).toHaveBeenCalledWith("http://x/api/v1/hosts/a/inventory", {
      headers: { accept: "application/json" },
    });
  });

  it("preserves a non-empty bootstrap error body and omits an absent API key", async () => {
    const identity = { hostId: "a", apiUrl: "http://x" };
    expect(emptyDaemonConfig(identity).apiKey).toBeUndefined();
    await expect(
      fetchHostInventory(identity, {
        fetchFn: async () => new Response("storage unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("storage unavailable");
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  emptyAgentConfig,
  fetchAgentHostConfig,
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

describe("fetchAgentHostConfig", () => {
  it("maps identity and host inventory", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        repositories: valid.repositories,
        commandProfiles: valid.commandProfiles,
        logLevel: "warn",
      }),
    );
    const config = await fetchAgentHostConfig(
      {
        hostId: "local-1",
        apiUrl: "ws://127.0.0.1:7420/ws",
        apiKey: "hns_x",
        logLevel: "debug",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(config.hostId).toBe("local-1");
    expect(config.apiUrl).toBe("ws://127.0.0.1:7420/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("debug");
    expect(config.repositories[0]?.id).toBe("repo-1");
  });

  it("returns empty inventory when host config is not yet set (404)", async () => {
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    const config = await fetchAgentHostConfig(
      { hostId: "a", apiUrl: "http://127.0.0.1:7420", logLevel: "info" },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(config.hostId).toBe("a");
    expect(config.repositories).toEqual([]);
    expect(config.commandProfiles).toEqual({});
  });

  it("emptyAgentConfig and inventoryFingerprint", () => {
    const empty = emptyAgentConfig({
      hostId: "a",
      apiUrl: "http://x",
      apiKey: "k",
      logLevel: "warn",
    });
    expect(empty.repositories).toEqual([]);
    expect(empty.apiKey).toBe("k");
    expect(inventoryFingerprint(empty)).toBe(
      inventoryFingerprint({
        hostId: "a",
        repositories: [],
        providerAccounts: [],
        commandProfiles: {},
        logLevel: "info",
      }),
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
      fetchAgentHostConfig(
        { hostId: "a", apiUrl: "http://x", logLevel: "info" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/bootstrap failed \(500\).*err/);
  });
});

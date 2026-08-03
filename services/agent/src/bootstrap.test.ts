import { describe, expect, it, vi } from "vitest";

import { fetchAgentHostConfig, httpBaseFromApiUrl } from "./bootstrap.ts";
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
        agentId: "local-1",
        apiUrl: "ws://127.0.0.1:7420/ws",
        apiKey: "hns_x",
        logLevel: "debug",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(config.agentId).toBe("local-1");
    expect(config.apiUrl).toBe("ws://127.0.0.1:7420/ws");
    expect(config.apiKey).toBe("hns_x");
    expect(config.logLevel).toBe("debug");
    expect(config.repositories[0]?.id).toBe("repo-1");
  });

  it("throws a helpful error when host config is missing", async () => {
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 404, statusText: "Not Found" }),
    );
    await expect(
      fetchAgentHostConfig(
        { agentId: "a", apiUrl: "http://127.0.0.1:7420", logLevel: "info" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/bootstrap failed \(404\).*PUT \/api\/v1\/agents\/a\/config/);
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
        { agentId: "a", apiUrl: "http://x", logLevel: "info" },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/bootstrap failed \(500\).*err/);
  });
});

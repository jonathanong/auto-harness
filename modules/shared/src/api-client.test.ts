import { afterEach, describe, expect, it } from "vitest";

import { apiBase, apiErrorMessage, apiGet, resolveServerApiBase } from "./api-client.ts";

function withWindow<T>(fn: () => T): T {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = original;
    }
  }
}

describe("resolveServerApiBase", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
    delete process.env.HARNESS_API_URL;
  });

  it("falls back to the local default when nothing is set", () => {
    expect(resolveServerApiBase()).toBe("http://127.0.0.1:7420");
  });

  it("prefers HARNESS_API_HTTP, trims whitespace and a trailing slash", () => {
    process.env.HARNESS_API_HTTP = " http://example.test:9000/ ";
    process.env.HARNESS_API_URL = "http://ignored.test";
    expect(resolveServerApiBase()).toBe("http://example.test:9000");
  });

  it("falls back to HARNESS_API_URL when HTTP is unset", () => {
    process.env.HARNESS_API_URL = "http://example.test:9001";
    expect(resolveServerApiBase()).toBe("http://example.test:9001");
  });

  it("rewrites ws:// to http:// and strips a trailing /ws", () => {
    process.env.HARNESS_API_URL = "ws://example.test:9002/ws";
    expect(resolveServerApiBase()).toBe("http://example.test:9002");
  });

  it("rewrites wss:// to https:// and strips a trailing /ws/", () => {
    process.env.HARNESS_API_URL = "wss://example.test:9003/ws/";
    expect(resolveServerApiBase()).toBe("https://example.test:9003");
  });
});

describe("apiBase", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("returns empty string in the browser (same-origin)", () => {
    withWindow(() => {
      expect(apiBase()).toBe("");
    });
  });

  it("returns the resolved server base outside the browser", () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9004";
    expect(apiBase()).toBe("http://example.test:9004");
  });
});

describe("apiGet", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("returns parsed JSON on success", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9005";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      expect(String(input)).toBe("http://example.test:9005/api/v1/hosts");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      expect(await apiGet<{ items: unknown[] }>("/api/v1/hosts")).toEqual({ items: [] });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws with the path and status on failure", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9006";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    try {
      await expect(apiGet("/api/v1/hosts")).rejects.toThrow("GET /api/v1/hosts → 500");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("apiErrorMessage", () => {
  it("prefers a structured error message and falls back to status", async () => {
    await expect(
      apiErrorMessage(
        new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }), {
          status: 403,
        }),
      ),
    ).resolves.toBe("nope");
    await expect(
      apiErrorMessage(new Response(JSON.stringify({ error: {} }), { status: 409 })),
    ).resolves.toBe("request failed (409)");
    await expect(apiErrorMessage(new Response("not json", { status: 500 }))).resolves.toBe(
      "request failed (500)",
    );
  });
});

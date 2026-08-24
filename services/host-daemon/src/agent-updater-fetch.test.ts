import { describe, expect, it } from "vitest";

import { createHttpsUpdateFetcher } from "./agent-updater-fetch.ts";

describe("HTTPS update fetcher", () => {
  it("rejects non-https manifest URLs", () => {
    expect(() => createHttpsUpdateFetcher("http://updates.example.test/manifest.json")).toThrow(
      "update manifest URL must be https",
    );
  });

  it("fetches a JSON manifest and artifact bytes", async () => {
    const fetcher = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async (url) => {
        if (url.endsWith("manifest.json")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ version: "1.2.0" }),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      },
    );
    await expect(fetcher.fetchManifest()).resolves.toEqual({ version: "1.2.0" });
    await expect(fetcher.fetchArtifact("https://updates.example.test/agent.tgz")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("fails closed on HTTP errors, timeouts, and http artifacts", async () => {
    const fetcher = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    );
    await expect(fetcher.fetchManifest()).rejects.toThrow("update manifest fetch failed: 503");
    await expect(fetcher.fetchArtifact("http://updates.example.test/agent.tgz")).rejects.toThrow(
      "update artifact URL must be https",
    );

    const slow = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async (_url, init) =>
        await new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      5,
    );
    await expect(slow.fetchManifest()).rejects.toThrow("update fetch timed out");

    const stalledBody = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async (_url, init) => ({
        ok: true,
        status: 200,
        json: async () =>
          await new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
          }),
        arrayBuffer: async () =>
          await new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("body aborted")));
          }),
      }),
      5,
    );
    await expect(stalledBody.fetchManifest()).rejects.toThrow("update fetch timed out");
    await expect(
      stalledBody.fetchArtifact("https://updates.example.test/agent.tgz"),
    ).rejects.toThrow("update fetch timed out");

    const exploding = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async () => {
        throw new Error("network down");
      },
    );
    await expect(exploding.fetchManifest()).rejects.toThrow("network down");
    await expect(
      createHttpsUpdateFetcher("https://updates.example.test/manifest.json", async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      })).fetchArtifact("https://updates.example.test/agent.tgz"),
    ).rejects.toThrow("update artifact fetch failed: 404");
  });

  it("rejects oversized streamed update responses before buffering", async () => {
    const fetcher = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async (url) => ({
        ok: true,
        status: 200,
        headers: {
          get: () =>
            url.endsWith("manifest.json") ? String(64 * 1024 + 1) : String(512 * 1024 * 1024 + 1),
        },
        body: {
          getReader: () => {
            throw new Error("body must not be read");
          },
        },
      }),
    );
    await expect(fetcher.fetchManifest()).rejects.toThrow("manifest response exceeds");
    await expect(fetcher.fetchArtifact("https://updates.example.test/agent.tgz")).rejects.toThrow(
      "artifact response exceeds",
    );
  });

  it("cancels a manifest stream that exceeds its limit without a length header", async () => {
    let cancelled = false;
    const fetcher = createHttpsUpdateFetcher(
      "https://updates.example.test/manifest.json",
      async () => ({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: new Uint8Array(64 * 1024 + 1) }),
            cancel: async () => {
              cancelled = true;
            },
          }),
        },
      }),
    );
    await expect(fetcher.fetchManifest()).rejects.toThrow("manifest response exceeds");
    expect(cancelled).toBe(true);
  });
});

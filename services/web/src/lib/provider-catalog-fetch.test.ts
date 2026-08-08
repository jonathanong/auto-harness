import { afterEach, describe, expect, it } from "vitest";

import { fetchProviderCatalogLookups } from "./provider-catalog-fetch.ts";

describe("fetchProviderCatalogLookups", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("builds id-keyed lookup maps and a ProviderCatalog from the three list endpoints", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9200";
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/providers")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "prov-1",
                name: "claude",
                defaultCommandId: "cmd-1",
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/v1/provider-accounts")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "acct-1",
                providerId: "prov-1",
                label: "x@y.com",
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          }),
        );
      }
      if (url.endsWith("/api/v1/commands")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "cmd-1",
                name: "claude-print",
                argv: ["claude"],
                appendPrompt: true,
                providerId: "prov-1",
                createdAt: "t",
                updatedAt: "t",
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    try {
      const result = await fetchProviderCatalogLookups();
      expect(Object.keys(result.providersById)).toEqual(["prov-1"]);
      expect(Object.keys(result.providerAccountsById)).toEqual(["acct-1"]);
      expect(Object.keys(result.commandsById)).toEqual(["cmd-1"]);
      expect(result.catalog).toEqual({
        providers: result.providersById,
        providerAccounts: result.providerAccountsById,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("treats a response with no items array as empty for all three endpoints", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9202";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}))) as typeof fetch;
    try {
      const result = await fetchProviderCatalogLookups();
      expect(result.providersById).toEqual({});
      expect(result.providerAccountsById).toEqual({});
      expect(result.commandsById).toEqual({});
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns empty lookups when a fetch fails, rather than throwing", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9201";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    try {
      const result = await fetchProviderCatalogLookups();
      expect(result.providersById).toEqual({});
      expect(result.providerAccountsById).toEqual({});
      expect(result.commandsById).toEqual({});
      expect(result.catalog).toEqual({ providers: {}, providerAccounts: {} });
    } finally {
      globalThis.fetch = original;
    }
  });
});

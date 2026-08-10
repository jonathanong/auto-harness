import { afterEach, describe, expect, it } from "vitest";

import { getInventory, putInventory } from "./host-inventory-api.ts";

describe("getInventory / putInventory", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("getInventory returns empty inventory on a non-ok response", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9100";
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toEqual([]);
      expect(inv.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("getInventory narrows fields and round-trips a valid logLevel", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9101";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          repositories: [{ id: "r1", path: "/r", defaultBranch: "main", worktrees: [] }],
          commandProfiles: { p: { argv: ["true"], appendPrompt: false } },
          capabilities: ["scheduled-main-checkout", "not-real"],
          logLevel: "debug",
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toHaveLength(1);
      expect(inv.logLevel).toBe("debug");
      expect(inv.capabilities).toEqual(["scheduled-main-checkout"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("getInventory drops an invalid logLevel and falls back to defaults for malformed fields", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9102";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repositories: "nope", logLevel: "bogus" }), {
        status: 200,
      })) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toEqual([]);
      expect(inv.commandProfiles["echo-prompt"]?.argv).toEqual(["echo"]);
      expect(inv.logLevel).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("putInventory sends repositories/commandProfiles/logLevel and reports failure text", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9103";
    const original = globalThis.fetch;
    let sentBody: unknown;
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const ok = await putInventory("host-1", {
        repositories: [],
        providerAccounts: [],
        commandProfiles: {},
        capabilities: ["scheduled-main-checkout"],
        logLevel: "warn",
      });
      expect(ok).toEqual({ ok: true });
      expect(sentBody).toEqual({
        repositories: [],
        providerAccounts: [],
        commandProfiles: {},
        capabilities: ["scheduled-main-checkout"],
        logLevel: "warn",
      });
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    try {
      const failed = await putInventory("host-1", {
        repositories: [],
        providerAccounts: [],
        commandProfiles: {},
      });
      expect(failed).toEqual({ ok: false, error: "bad request" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

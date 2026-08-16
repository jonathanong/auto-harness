import { afterEach, describe, expect, it } from "vitest";

import { getInventory, mutateInventory, putInventory } from "./host-inventory-api.ts";

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
      expect(inv.providerAccounts).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("getInventory narrows repositories/providerAccounts and filters capabilities", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9101";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          repositories: [{ id: "r1", path: "/r", defaultBranch: "main", worktrees: [] }],
          capabilities: ["scheduled-main-checkout", "not-real"],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toHaveLength(1);
      expect(inv.capabilities).toEqual(["scheduled-main-checkout"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("getInventory falls back to defaults for malformed fields", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9102";
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ repositories: "nope", providerAccounts: "nope" }), {
        status: 200,
      })) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toEqual([]);
      expect(inv.providerAccounts).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("putInventory sends repositories/providerAccounts/capabilities and reports failure text", async () => {
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
        capabilities: ["scheduled-main-checkout"],
      });
      expect(ok).toEqual({ ok: true });
      expect(sentBody).toEqual({
        repositories: [],
        providerAccounts: [],
        capabilities: ["scheduled-main-checkout"],
      });
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    try {
      const failed = await putInventory("host-1", {
        repositories: [],
        providerAccounts: [],
      });
      expect(failed).toEqual({ ok: false, error: "bad request" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * PUT replaces the whole document, so two editors working from their own reads used to
 * discard one another's changes. mutateInventory re-reads immediately before writing and
 * conditions the write on that read, reapplying the change if it lost the race.
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}

describe("mutateInventory", () => {
  const empty = { repositories: [], providerAccounts: [], capabilities: [] };

  it("sends the version it just read, not one from an earlier render", async () => {
    const original = globalThis.fetch;
    try {
      const calls = stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ ...empty, version: 7 }), { status: 200 }),
      );

      await expect(mutateInventory("host-1", (current) => current)).resolves.toEqual({ ok: true });

      const put = calls.find((call) => call.init?.method === "PUT");
      expect(JSON.parse(String(put?.init?.body))).toMatchObject({ version: 7 });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("re-reads and reapplies when it loses the race", async () => {
    const original = globalThis.fetch;
    try {
      let version = 1;
      let puts = 0;
      const calls = stubFetch((_url, init) => {
        if (init?.method !== "PUT") {
          return new Response(JSON.stringify({ ...empty, version }), { status: 200 });
        }
        puts += 1;
        // The first write loses to a concurrent editor, which leaves version 2 behind.
        if (puts === 1) {
          version = 2;
          return new Response("conflict", { status: 409 });
        }
        return new Response(null, { status: 204 });
      });

      await expect(mutateInventory("host-1", (current) => current)).resolves.toEqual({ ok: true });

      const puttedVersions = calls
        .filter((call) => call.init?.method === "PUT")
        .map((call) => (JSON.parse(String(call.init?.body)) as { version: number }).version);
      expect(puttedVersions).toEqual([1, 2]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives up after repeated conflicts rather than looping", async () => {
    const original = globalThis.fetch;
    try {
      const calls = stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response("conflict", { status: 409 })
          : new Response(JSON.stringify({ ...empty, version: 1 }), { status: 200 }),
      );

      const result = await mutateInventory("host-1", (current) => current);

      expect(result).toMatchObject({ ok: false });
      expect(calls.filter((call) => call.init?.method === "PUT")).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces a non-conflict failure immediately", async () => {
    const original = globalThis.fetch;
    try {
      const calls = stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response("nope", { status: 400 })
          : new Response(JSON.stringify(empty), { status: 200 }),
      );

      await expect(mutateInventory("host-1", (current) => current)).resolves.toEqual({
        ok: false,
        error: "nope",
      });
      expect(calls.filter((call) => call.init?.method === "PUT")).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

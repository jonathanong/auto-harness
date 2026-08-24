/* eslint-disable max-lines -- inventory and exec-config client writes share fetch stubs. */
import { afterEach, describe, expect, it } from "vitest";

import {
  getInventory,
  mutateExecConfig,
  mutateInventory,
  putExecConfig,
  putInventory,
} from "./host-inventory-api.ts";

describe("getInventory / putInventory", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("getInventory returns empty inventory when the host has no inventory yet", async () => {
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
          setupScript: "source ~/.zshrc",
          allowedRoots: ["/opt/harness"],
          requiredEnvironment: ["TOKEN"],
          repositories: [{ id: "r1", path: "/r", defaultBranch: "main", worktrees: [] }],
          capabilities: ["scheduled-main-checkout", "not-real"],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const inv = await getInventory("host-1");
      expect(inv.repositories).toHaveLength(1);
      expect(inv.setupScript).toBe("source ~/.zshrc");
      expect(inv.allowedRoots).toEqual(["/opt/harness"]);
      expect(inv.requiredEnvironment).toEqual(["TOKEN"]);
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
        setupScript: "source ~/.zshrc",
        allowedRoots: ["/opt/harness"],
        requiredEnvironment: ["TOKEN"],
        repositories: [],
        providerAccounts: [],
        capabilities: ["scheduled-main-checkout"],
      });
      expect(ok).toEqual({ ok: true });
      expect(sentBody).toEqual({
        setupScript: "source ~/.zshrc",
        allowedRoots: ["/opt/harness"],
        requiredEnvironment: ["TOKEN"],
        repositories: [],
        providerAccounts: [],
        capabilities: ["scheduled-main-checkout"],
      });
    } finally {
      globalThis.fetch = original;
    }

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
      })) as typeof fetch;
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

  it("putExecConfig writes the exec-config subset and reports conflicts", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9104";
    const original = globalThis.fetch;
    let sent: { url?: string; body?: unknown } = {};
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)) };
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        putExecConfig(
          "host-1",
          {
            setupScript: "echo",
            allowedRoots: ["/opt/harness"],
            repositories: [{ id: "repo", terminalHookScript: "/opt/harness/hook.sh" }],
          },
          3,
        ),
      ).resolves.toEqual({ ok: true });
      expect(sent.url).toContain("/exec-config");
      expect(sent.body).toEqual({
        setupScript: "echo",
        allowedRoots: ["/opt/harness"],
        repositories: [{ id: "repo", terminalHookScript: "/opt/harness/hook.sh" }],
        version: 3,
      });
      await expect(putExecConfig("host-1", {})).resolves.toEqual({ ok: true });
      expect(sent.body).toEqual({});
    } finally {
      globalThis.fetch = original;
    }
    globalThis.fetch = (async () => new Response("conflict", { status: 409 })) as typeof fetch;
    try {
      await expect(putExecConfig("host-1", { setupScript: "x" })).resolves.toEqual({
        ok: false,
        conflict: true,
        error: "conflict",
      });
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
    calls.push({ url, ...(init ? { init } : {}) });
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

describe("mutateExecConfig", () => {
  const empty = { repositories: [], providerAccounts: [], capabilities: [] };

  it("sends the exec-config patch against the version it just read", async () => {
    const original = globalThis.fetch;
    try {
      const calls = stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ ...empty, version: 4 }), { status: 200 }),
      );
      await expect(
        mutateExecConfig("host-1", () => ({ setupScript: "echo", allowedRoots: ["/opt"] })),
      ).resolves.toEqual({ ok: true });
      const put = calls.find((call) => call.init?.method === "PUT");
      expect(String(put?.url)).toContain("/exec-config");
      expect(JSON.parse(String(put?.init?.body))).toMatchObject({
        setupScript: "echo",
        allowedRoots: ["/opt"],
        version: 4,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces read failures and non-conflict write failures", async () => {
    const original = globalThis.fetch;
    try {
      stubFetch(() => new Response("nope", { status: 500 }));
      await expect(mutateExecConfig("host-1", () => ({}))).resolves.toMatchObject({ ok: false });
      globalThis.fetch = (async () => {
        throw "offline";
      }) as typeof fetch;
      await expect(mutateExecConfig("host-1", () => ({}))).resolves.toEqual({
        ok: false,
        error: "offline",
      });
      stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response("nope", { status: 400 })
          : new Response(JSON.stringify(empty), { status: 200 }),
      );
      await expect(mutateExecConfig("host-1", () => ({ setupScript: "x" }))).resolves.toEqual({
        ok: false,
        error: "nope",
      });
      stubFetch((_url, init) =>
        init?.method === "PUT"
          ? new Response("conflict", { status: 409 })
          : new Response(JSON.stringify(empty), { status: 200 }),
      );
      await expect(mutateExecConfig("host-1", () => ({ setupScript: "x" }))).resolves.toMatchObject(
        {
          ok: false,
          error: "conflict",
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

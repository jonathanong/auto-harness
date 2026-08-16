import { afterEach, describe, expect, it } from "vitest";

import { attachLocalRepo } from "./attach-local-repo.ts";

const empty = {
  repositories: [
    {
      id: "other",
      path: "/other",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: "/other/wt", labels: [] }],
    },
  ],
  providerAccounts: [],
  capabilities: [],
};

describe("attachLocalRepo", () => {
  afterEach(() => {
    delete process.env.HARNESS_API_HTTP;
  });

  it("conditions the write on the version it just read and keeps existing worktrees", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9200";
    const original = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ...empty, version: 4 }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        attachLocalRepo({ hostId: "host-1", id: "repo-1", path: "/repo", defaultBranch: "trunk" }),
      ).resolves.toEqual({ ok: true });
      expect(bodies).toEqual([
        expect.objectContaining({
          version: 4,
          repositories: expect.arrayContaining([
            expect.objectContaining({
              id: "other",
              worktrees: [expect.objectContaining({ id: "wt-1" })],
            }),
            expect.objectContaining({ id: "repo-1", path: "/repo", defaultBranch: "trunk" }),
          ]),
        }),
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("re-reads and retries when a concurrent editor wins the first PUT", async () => {
    process.env.HARNESS_API_HTTP = "http://example.test:9201";
    const original = globalThis.fetch;
    let version = 1;
    let puts = 0;
    const putVersions: number[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") {
        return new Response(JSON.stringify({ ...empty, version }), { status: 200 });
      }
      puts += 1;
      putVersions.push((JSON.parse(String(init.body)) as { version: number }).version);
      if (puts === 1) {
        version = 2;
        return new Response("conflict", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      await expect(
        attachLocalRepo({ hostId: "host-1", id: "repo-1", path: "/repo", defaultBranch: "main" }),
      ).resolves.toEqual({ ok: true });
      expect(putVersions).toEqual([1, 2]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

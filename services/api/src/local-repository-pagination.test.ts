import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function signCursor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

describe("repository list pagination", () => {
  it("enforces bounds, returns pages, and replays a cursor deterministically", async () => {
    const plane = new ControlPlane({
      repositoryIdFactory: (() => {
        let n = 0;
        return () => `repo-${++n}`;
      })(),
      sessionCursorSecret: "repository-pagination-test-secret",
    });
    for (const name of ["charlie", "alpha", "bravo"]) {
      expect(plane.createRepository({ name, url: `/${name}` }).ok).toBe(true);
    }
    const { handler } = createLocalApp({ plane, rateLimitConfig: { enabled: false } });
    const invoke = (path: string) => invokeHandler(handler, "GET", path);

    expect((await invoke("/api/v1/repositories?limit=0")).status).toBe(400);
    expect((await invoke("/api/v1/repositories?limit=101")).status).toBe(400);
    expect((await invoke("/api/v1/repositories?limit=abc")).status).toBe(400);
    expect(() => plane.listRepositoriesPage({ limit: 1.5 })).toThrow("limit must be");
    expect((await invoke("/api/v1/repositories?limit=2&limit=2")).status).toBe(400);
    expect((await invoke("/api/v1/repositories?limit=1")).json).toMatchObject({
      items: [{ name: "alpha" }],
      nextCursor: expect.any(String),
    });
    expect((await invoke("/api/v1/repositories?limit=100")).json).toMatchObject({
      items: [{ name: "alpha" }, { name: "bravo" }, { name: "charlie" }],
      nextCursor: null,
    });

    const first = await invoke("/api/v1/repositories?limit=2");
    expect(first.status).toBe(200);
    const firstPage = first.json as { items: Array<{ name: string }>; nextCursor: string };
    expect(firstPage.items.map((repository) => repository.name)).toEqual(["alpha", "bravo"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await invoke(
      `/api/v1/repositories?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    const secondPage = second.json as { items: Array<{ name: string }>; nextCursor: string | null };
    expect(secondPage.items.map((repository) => repository.name)).toEqual(["charlie"]);
    expect(secondPage.nextCursor).toBeNull();

    const replay = await invoke(
      `/api/v1/repositories?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    expect(replay.json).toEqual(second.json);
    expect((await invoke("/api/v1/repositories?cursor=not-a-cursor")).status).toBe(400);

    const malformedPayload = Buffer.from("{", "utf8").toString("base64url");
    expect(() =>
      plane.listRepositoriesPage({
        cursor: `${malformedPayload}.${signCursor(malformedPayload, "repository-pagination-test-secret")}`,
      }),
    ).toThrow();
    const nullPayload = Buffer.from("null", "utf8").toString("base64url");
    expect(() =>
      plane.listRepositoriesPage({
        cursor: `${nullPayload}.${signCursor(nullPayload, "repository-pagination-test-secret")}`,
      }),
    ).toThrow();
    const objectPayload = Buffer.from(
      JSON.stringify({ version: 1, scopeDigest: "wrong", position: { name: "n", id: "id" } }),
      "utf8",
    ).toString("base64url");
    expect(() => plane.listRepositoriesPage({ cursor: `${objectPayload}.a` })).toThrow();
    const invalidPosition = Buffer.from(
      JSON.stringify({ version: 1, scope: null, position: { name: 1, id: "repo" } }),
      "utf8",
    ).toString("base64url");
    expect(() =>
      plane.listRepositoriesPage({
        cursor: `${invalidPosition}.${signCursor(invalidPosition, "repository-pagination-test-secret")}`,
      }),
    ).toThrow();
  });

  it("filters visibility before applying the page size", () => {
    const plane = new ControlPlane({ sessionCursorSecret: "repository-scope-test-secret" });
    for (const [id, name] of [
      ["repo-a", "alpha"],
      ["repo-b", "bravo"],
      ["repo-c", "charlie"],
    ] as const) {
      plane.createRepository({ id, name, url: `/${name}` });
    }
    const scoped = plane.listRepositoriesPage({ limit: 1, scope: ["repo-b", "repo-c"] });
    expect(scoped.items.map((repository) => repository.id)).toEqual(["repo-b"]);
    expect(scoped.nextCursor).toEqual(expect.any(String));
    expect(() =>
      plane.listRepositoriesPage({ cursor: scoped.nextCursor!, scope: ["repo-a", "repo-b"] }),
    ).toThrow("invalid or mismatched repository cursor");
  });

  it("passes opaque continuation keys to durable storage with a fixed-size scope binding", async () => {
    const queries: Array<Record<string, unknown>> = [];
    const plane = new ControlPlane({
      sessionCursorSecret: "repository-durable-page-secret",
      storage: {
        listRepositoriesPage: async (query: Record<string, unknown>) => {
          queries.push(query);
          return query.startKey
            ? {
                items: [
                  {
                    id: "invalid",
                    name: "Invalid",
                    url: "/invalid",
                    admissionState: "invalid",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
                nextKey: null,
              }
            : {
                items: [
                  {
                    id: "repo-a",
                    name: "Alpha",
                    url: "/alpha",
                    defaultBranch: "main",
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ],
                nextKey: { id: "repo-a" },
              };
        },
      } as never,
    });
    const scope = Array.from({ length: 500 }, (_, index) => `repository-${index}`);
    scope.push("repo-a");
    const first = await plane.listRepositoriesPageDurable({ limit: 1, scope });
    expect(first.items).toMatchObject([{ id: "repo-a", admissionState: "active" }]);
    expect(first.nextCursor?.length).toBeLessThan(500);
    expect(() => plane.listRepositoriesPage({ cursor: first.nextCursor!, scope })).toThrow(
      "invalid or mismatched repository cursor",
    );
    await expect(
      plane.listRepositoriesPageDurable({ limit: 1, scope, cursor: first.nextCursor! }),
    ).resolves.toEqual({ items: [], nextCursor: null });

    const memory = new ControlPlane({
      sessionCursorSecret: "repository-durable-page-secret",
    });
    memory.createRepository({ id: "one", name: "one", url: "/one" });
    memory.createRepository({ id: "two", name: "two", url: "/two" });
    const positionCursor = memory.listRepositoriesPage({ limit: 1 }).nextCursor!;
    await expect(plane.listRepositoriesPageDurable({ cursor: positionCursor })).rejects.toThrow(
      "invalid or mismatched repository cursor",
    );
    await expect(plane.listRepositoriesPageDurable({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "repo-a" }],
    });
    expect(queries).toEqual([
      { limit: 1, allowedRepositoryIds: scope.toSorted((a, b) => a.localeCompare(b)) },
      {
        limit: 1,
        startKey: { id: "repo-a" },
        allowedRepositoryIds: scope.toSorted((a, b) => a.localeCompare(b)),
      },
      { limit: 1 },
    ]);
  });

  it("pages through durable storage adapters without a native page method", async () => {
    const plane = new ControlPlane({
      storage: {
        listRepositories: async () => [
          { id: "repo-b", name: "Bravo", url: "/bravo" },
          { id: "repo-a", name: "Alpha", url: "/alpha" },
        ],
      } as never,
    });

    await expect(plane.listRepositoriesPageDurable({ limit: 1 })).resolves.toMatchObject({
      items: [{ id: "repo-a" }],
      nextCursor: expect.any(String),
    });
  });
});

import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function addRepository(plane: ControlPlane, id: string, name: string): void {
  expect(plane.createRepository({ id, name, url: `https://example.test/${name}` }).ok).toBe(true);
}

describe("repository list pagination route", () => {
  it("rejects malformed or duplicated pagination parameters", async () => {
    const { handler } = createLocalApp({ plane: new ControlPlane() });
    for (const query of [
      "limit=",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=1&limit=2",
      "cursor=",
      "cursor=one&cursor=two",
      "cursor=bogus",
    ]) {
      const response = await invokeHandler(handler, "GET", `/api/v1/repositories?${query}`);
      expect(response.status).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("filters visible repositories before paging and counts only the returned page", async () => {
    const plane = new ControlPlane({ sessionCursorSecret: "repository-route-test-secret" });
    addRepository(plane, "repository-a", "alpha");
    addRepository(plane, "repository-b", "bravo");
    addRepository(plane, "repository-c", "charlie");
    const countRequests: string[][] = [];
    vi.spyOn(plane, "listRepositoryCountsDurable").mockImplementation(async (repositoryIds) => {
      countRequests.push([...repositoryIds]);
      return new Map(
        repositoryIds.map((id) => [
          id,
          { sessionCount: id === "repository-a" ? 3 : 0, worktreeCount: 0, scheduleCount: 0 },
        ]),
      );
    });
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey: firstKey } = await auth.createServiceAccount({
      name: "first",
      role: "agent",
      allowedRepositoryIds: ["repository-c", "repository-a"],
      boundHostId: "host-a",
    });
    const { apiKey: otherKey } = await auth.createServiceAccount({
      name: "other",
      role: "agent",
      allowedRepositoryIds: ["repository-b"],
      boundHostId: "host-b",
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (path: string, key = firstKey) =>
      invokeHandler(handler, "GET", path, undefined, { authorization: `Bearer ${key}` });

    const first = await invoke("/api/v1/repositories?limit=1");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      items: [{ id: "repository-a", sessionCount: 3 }],
      nextCursor: expect.any(String),
    });
    const cursor = (first.json as { nextCursor: string }).nextCursor;
    expect(countRequests).toEqual([["repository-a"]]);

    const second = await invoke(
      `/api/v1/repositories?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      items: [{ id: "repository-c" }],
      nextCursor: null,
    });
    expect(countRequests).toEqual([["repository-a"], ["repository-c"]]);
    expect(
      (await invoke(`/api/v1/repositories?limit=1&cursor=${encodeURIComponent(cursor)}`, otherKey))
        .status,
    ).toBe(400);
    expect(
      (await invoke(`/api/v1/repositories?limit=1&cursor=${encodeURIComponent(`${cursor}x`)}`))
        .status,
    ).toBe(400);
  });
});

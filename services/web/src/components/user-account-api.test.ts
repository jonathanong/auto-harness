import { afterEach, describe, expect, it, vi } from "vitest";

import { createUserAccount, deleteUserAccount, loadUserAccounts } from "./user-account-api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function replies(...values: Response[]) {
  const queue = [...values];
  const fetch = vi.fn(async () => {
    const response = queue.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("user-account API client", () => {
  it("loads public user accounts without inventing missing items", async () => {
    const account = { id: "user:alice", username: "alice", role: "operator", kind: "user" };
    replies(
      json({ items: [account] }),
      json({ items: [{ id: "r-1", name: "Repo" }] }),
      json({}),
      json({}),
    );
    await expect(loadUserAccounts()).resolves.toEqual({
      kind: "ready",
      accounts: [account],
      repositories: [{ id: "r-1", name: "Repo" }],
    });
    await expect(loadUserAccounts()).resolves.toEqual({
      kind: "ready",
      accounts: [],
      repositories: [],
    });
  });

  it("preserves authorization states and readable load errors", async () => {
    replies(new Response(null, { status: 401 }), new Response(null, { status: 403 }));
    await expect(loadUserAccounts()).resolves.toEqual({ kind: "unauthorized" });
    await expect(loadUserAccounts()).resolves.toEqual({ kind: "forbidden" });
    replies(json({ error: { message: "users unavailable" } }, 503));
    await expect(loadUserAccounts()).rejects.toThrow("users unavailable");
    replies(new Response("bad gateway", { status: 502 }));
    await expect(loadUserAccounts()).rejects.toThrow("bad gateway");
    replies(json({ items: [] }), new Response(null, { status: 401 }));
    await expect(loadUserAccounts()).resolves.toEqual({ kind: "unauthorized" });
    replies(json({ items: [] }), new Response("catalog offline", { status: 502 }));
    await expect(loadUserAccounts()).rejects.toThrow("catalog offline");
  });

  it("aggregates repository scope choices across cursor pages", async () => {
    const fetch = replies(
      json({ items: [] }),
      json({ items: [{ id: "r-1", name: "First" }], nextCursor: "next" }),
      json({ items: [{ id: "r-2", name: "Second" }], nextCursor: null }),
    );
    await expect(loadUserAccounts()).resolves.toMatchObject({
      kind: "ready",
      repositories: [
        { id: "r-1", name: "First" },
        { id: "r-2", name: "Second" },
      ],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/v1/repositories?cursor=next",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("creates an account using only the supplied initial password", async () => {
    const account = { id: "user:alice", username: "alice", role: "admin", kind: "user" };
    const fetch = replies(json(account, 201));
    await expect(
      createUserAccount({ username: "alice", password: "initial-password", role: "admin" }),
    ).resolves.toEqual(account);
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "initial-password",
        role: "admin",
      }),
      credentials: "same-origin",
    });
    replies(json({ error: { message: "username already exists" } }, 409));
    await expect(
      createUserAccount({ username: "alice", password: "secret", role: "operator" }),
    ).rejects.toThrow("username already exists");
  });

  it("deletes encoded usernames and surfaces failures", async () => {
    const fetch = replies(new Response(null, { status: 204 }));
    await deleteUserAccount("alice/example");
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/users/alice%2Fexample", {
      method: "DELETE",
      credentials: "same-origin",
    });
    replies(new Response(null, { status: 500 }));
    await expect(deleteUserAccount("alice")).rejects.toThrow("request failed (500)");
  });
});

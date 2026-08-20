import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createServiceAccount,
  deleteServiceAccount,
  loadServiceAccountData,
} from "./service-account-api.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function replies(...values: Array<Response | Promise<Response>>) {
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

describe("service-account API client", () => {
  it("loads accounts and repository choices without inventing missing items", async () => {
    replies(
      json({ items: [{ id: "service:1", name: "ci", role: "operator", createdAt: "now" }] }),
      json({ items: [{ id: "repo-1", name: "Repo one" }] }),
      json({}),
      json({}),
    );
    await expect(loadServiceAccountData()).resolves.toEqual({
      kind: "ready",
      accounts: [{ id: "service:1", name: "ci", role: "operator", createdAt: "now" }],
      repositories: [{ id: "repo-1", name: "Repo one" }],
    });
    await expect(loadServiceAccountData()).resolves.toEqual({
      kind: "ready",
      accounts: [],
      repositories: [],
    });
  });

  it("preserves authorization states and readable load errors", async () => {
    replies(new Response(null, { status: 401 }), new Response(null, { status: 403 }));
    await expect(loadServiceAccountData()).resolves.toEqual({ kind: "unauthorized" });
    await expect(loadServiceAccountData()).resolves.toEqual({ kind: "forbidden" });

    replies(json({ error: { message: "accounts unavailable" } }, 503));
    await expect(loadServiceAccountData()).rejects.toThrow("accounts unavailable");
    replies(json({ items: [] }), new Response("bad gateway", { status: 502 }));
    await expect(loadServiceAccountData()).rejects.toThrow("bad gateway");
    replies(json({ items: [] }), new Response(null, { status: 401 }));
    await expect(loadServiceAccountData()).resolves.toEqual({ kind: "unauthorized" });
  });

  it("creates an account and returns only its one-time key response", async () => {
    const result = {
      account: { id: "service:1", name: "ci", role: "operator", createdAt: "now" },
      apiKey: "hns_one-time",
    };
    const fetch = replies(json(result, 201));
    await expect(createServiceAccount({ name: "ci", role: "operator" })).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/service-accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ci", role: "operator" }),
      credentials: "same-origin",
    });
  });

  it("rejects missing keys and surfaces create errors", async () => {
    replies(json({ account: {} }, 201), json({ apiKey: "wrong" }, 201));
    await expect(createServiceAccount({ name: "ci", role: "operator" })).rejects.toThrow(
      "one-time API key",
    );
    await expect(createServiceAccount({ name: "ci", role: "operator" })).rejects.toThrow(
      "one-time API key",
    );
    replies(json({ error: { message: "invalid scope" } }, 400));
    await expect(createServiceAccount({ name: "ci", role: "operator" })).rejects.toThrow(
      "invalid scope",
    );
  });

  it("deletes encoded account IDs and reports failures", async () => {
    const fetch = replies(new Response(null, { status: 204 }));
    await deleteServiceAccount("service/a");
    expect(fetch).toHaveBeenCalledWith("/api/v1/auth/service-accounts/service%2Fa", {
      method: "DELETE",
      credentials: "same-origin",
    });
    replies(new Response(null, { status: 500 }));
    await expect(deleteServiceAccount("service:1")).rejects.toThrow("request failed (500)");
  });
});

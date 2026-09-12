import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackOAuthClient } from "./slack-oauth-client.ts";

const client = createSlackOAuthClient({
  clientId: "client-id",
  clientSecret: "client-secret",
  signingSecret: "a".repeat(32),
});

afterEach(() => vi.unstubAllGlobals());

describe("Slack OAuth client", () => {
  it("exchanges a code and retains the bot rather than installing-user identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        access_token: "xoxb-token",
        app_id: "A123",
        bot_user_id: "UBOT",
        authed_user: { id: "UINSTALLER" },
        team: { id: "T123", name: "Workspace" },
        scope: "im:history,chat:write,app_mentions:read",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      client.exchangeCode({ code: "code", redirectUri: "https://h.example/callback" }),
    ).resolves.toEqual({
      botToken: "xoxb-token",
      workspaceId: "T123",
      workspaceName: "Workspace",
      appId: "A123",
      botUserId: "UBOT",
      scopes: ["app_mentions:read", "chat:write", "im:history"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.access",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("client_secret=client-secret");
  });

  it("fails closed for HTTP, Slack, malformed, and unreadable exchange responses", async () => {
    for (const response of [
      {
        ok: false,
        json: async () => ({
          ok: true,
          access_token: "xoxb",
          app_id: "A",
          team: { id: "T" },
          scope: "chat:write",
        }),
      },
      { ok: true, json: async () => ({ ok: false }) },
      { ok: true, json: async () => null },
      {
        ok: true,
        json: async () => {
          throw new Error("network body");
        },
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        client.exchangeCode({ code: "code", redirectUri: "https://h.example/callback" }),
      ).rejects.toThrow();
    }
  });

  it("accepts the minimum bot exchange shape and omits optional user metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: "xoxb-token",
          app_id: "A123",
          team: { id: "T123" },
          scope: ",",
        }),
      }),
    );
    await expect(
      client.exchangeCode({ code: "code", redirectUri: "https://h.example/callback" }),
    ).resolves.toEqual({
      botToken: "xoxb-token",
      workspaceId: "T123",
      appId: "A123",
      scopes: [],
    });
  });

  it("rejects exchanges missing each required trust-boundary field", async () => {
    const valid = {
      ok: true,
      access_token: "xoxb-token",
      app_id: "A123",
      team: { id: "T123" },
      scope: "chat:write",
    };
    const invalid = [
      { ...valid, access_token: 123 },
      { ...valid, app_id: 123 },
      { ...valid, team: null },
      { ...valid, team: { id: 123 } },
      { ...valid, scope: null },
      { ...valid, team: [] },
      [],
      "not-an-object",
    ];
    for (const value of invalid) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => value }));
      await expect(
        client.exchangeCode({ code: "code", redirectUri: "https://h.example/callback" }),
      ).rejects.toThrow("Slack OAuth exchange failed");
    }
  });

  it("aborts a token exchange that exceeds its bounded timeout", async () => {
    let signal: AbortSignal | undefined;
    const timeoutClient = createSlackOAuthClient(
      { clientId: "client-id", clientSecret: "client-secret", signingSecret: "a".repeat(32) },
      {
        timeoutMs: 1,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      },
    );
    await expect(
      timeoutClient.exchangeCode({ code: "code", redirectUri: "https://h.example/callback" }),
    ).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });

  it("revokes a rejected-install token and fails closed on bad revocation responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, revoked: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.revokeBotToken("xoxb-token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/auth.revoke",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer xoxb-token" }),
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, revoked: false }) }),
    );
    await expect(client.revokeBotToken("xoxb-token")).rejects.toThrow(
      "Slack OAuth token revocation failed",
    );

    for (const response of [
      { ok: false, json: async () => ({ ok: true, revoked: true }) },
      { ok: true, json: async () => null },
      { ok: true, json: async () => "invalid" },
      { ok: true, json: async () => ({ ok: false, revoked: true }) },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(client.revokeBotToken("xoxb-token")).rejects.toThrow(
        "Slack OAuth token revocation failed",
      );
    }
  });

  it("aborts token revocation that exceeds its bounded timeout", async () => {
    let signal: AbortSignal | undefined;
    const timeoutClient = createSlackOAuthClient(
      { clientId: "client-id", clientSecret: "client-secret", signingSecret: "a".repeat(32) },
      {
        timeoutMs: 1,
        fetch: async (_url, init) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      },
    );
    await expect(timeoutClient.revokeBotToken("xoxb-token")).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
  });
});

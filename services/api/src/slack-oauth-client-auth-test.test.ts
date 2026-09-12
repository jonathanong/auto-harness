import { afterEach, describe, expect, it, vi } from "vitest";

import { createSlackOAuthClient } from "./slack-oauth-client.ts";

const client = createSlackOAuthClient({
  clientId: "client-id",
  clientSecret: "client-secret",
  signingSecret: "a".repeat(32),
});

afterEach(() => vi.unstubAllGlobals());

describe("Slack auth.test client", () => {
  it("uses bounded auth.test to identify a manual bot token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        team_id: "T123",
        team: "Workspace",
        api_app_id: "A123",
        user_id: "UBOT",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.authTestBotToken!("xoxb-token")).resolves.toEqual({
      workspaceId: "T123",
      workspaceName: "Workspace",
      appId: "A123",
      botUserId: "UBOT",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer xoxb-token" }),
      }),
    );
  });

  it("fails closed when auth.test cannot identify a workspace", async () => {
    for (const response of [
      { ok: false, json: async () => ({ ok: true, team_id: "T123" }) },
      { ok: true, json: async () => ({ ok: false }) },
      { ok: true, json: async () => ({ ok: true, team_id: 123 }) },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(client.authTestBotToken!("xoxb-token")).rejects.toThrow(
        "Slack bot identity lookup failed",
      );
    }
  });
});

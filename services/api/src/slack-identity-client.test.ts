import { describe, expect, it, vi } from "vitest";

import { createSlackIdentityClient } from "./slack-identity-client.ts";

describe("Slack identity client", () => {
  it("accepts the required identity while omitting absent optional metadata", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, team_id: "T1" }),
    });
    const client = createSlackIdentityClient({ fetch, timeoutMs: 0 });

    await expect(client.authTestBotToken("xoxb-token")).resolves.toEqual({ workspaceId: "T1" });
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/auth.test",
      expect.objectContaining({
        body: expect.any(URLSearchParams),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects failed HTTP responses and malformed Slack identities", async () => {
    for (const response of [
      { ok: false, body: { ok: true, team_id: "T1" } },
      { ok: true, body: null },
      { ok: true, body: [] },
      { ok: true, body: { ok: false, team_id: "T1" } },
      { ok: true, body: { ok: true, team_id: 1 } },
    ]) {
      const client = createSlackIdentityClient({
        fetch: async () => ({ ok: response.ok, json: async () => response.body }),
        timeoutMs: 25,
      });
      await expect(client.authTestBotToken("xoxb-token")).rejects.toThrow(
        "Slack bot identity lookup failed",
      );
    }
  });
});

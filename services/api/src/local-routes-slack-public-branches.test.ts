import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import {
  slackTestCredentials as credentials,
  slackTestEncryptor as encryptor,
  slackTestNow as now,
} from "../test-helpers/slack-route-test-helpers.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

const exchange = {
  ok: true,
  access_token: "xoxb-1234567890-abcdefghij",
  app_id: "A123",
  team: { id: "T123", name: "Workspace" },
  scope: "chat:write",
};

async function start(app: ReturnType<typeof createLocalApp>["handler"]): Promise<string> {
  const result = await invokeHandler(app, "POST", "/api/v1/integrations/slack/oauth/start", {
    defaultChannel: "#harness",
  });
  return new URL((result.json as { url: string }).url).searchParams.get("state")!;
}

describe("Slack public route branch failures", () => {
  it("does not claim a successful start when its audit write fails", async () => {
    const plane = new ControlPlane({ now: () => now });
    plane.appendAuditLog = async () => {
      throw new Error("audit");
    };
    const app = createLocalApp({ plane, authMode: "disabled", slackAppCredentials: credentials });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).toMatchObject({ status: 500 });
  });

  it("does not hide state persistence errors when the failure audit also fails", async () => {
    const plane = new ControlPlane({ now: () => now });
    plane.state.storage = { putSlackOAuthState: async () => false } as never;
    plane.appendAuditLog = async () => {
      throw new Error("audit");
    };
    const app = createLocalApp({ plane, authMode: "disabled", slackAppCredentials: credentials });
    expect(
      await invokeHandler(app.handler, "POST", "/api/v1/integrations/slack/oauth/start", {
        defaultChannel: "#harness",
      }),
    ).toMatchObject({ status: 500 });
  });

  it("uses the default OAuth transport and handles callback audit failure", async () => {
    const plane = new ControlPlane({ now: () => now, secretEncryptor: encryptor });
    const app = createLocalApp({ plane, authMode: "disabled", slackAppCredentials: credentials });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => exchange }));
    const state = await start(app.handler);
    plane.appendAuditLog = async () => {
      throw new Error("audit");
    };
    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).toMatchObject({ status: 500 });
    vi.unstubAllGlobals();
  });

  it("does not hide OAuth transport errors when callback auditing fails", async () => {
    const plane = new ControlPlane({ now: () => now });
    const app = createLocalApp({ plane, authMode: "disabled", slackAppCredentials: credentials });
    const state = await start(app.handler);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    plane.appendAuditLog = async () => {
      throw new Error("audit");
    };
    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${state}&code=code`,
      ),
    ).toMatchObject({ status: 500 });
    vi.unstubAllGlobals();
  });

  it("returns unavailable when state consumption fails before resolving the deployment URL", async () => {
    const plane = new ControlPlane({ now: () => now });
    plane.state.storage = {
      consumeSlackOAuthState: async () => Promise.reject(new Error("storage unavailable")),
      putAuditLog: async () => undefined,
    } as never;
    const resolveSlackOAuthPublicBaseUrl = vi.fn(async () => undefined);
    const app = createLocalApp({
      plane,
      authMode: "disabled",
      slackAppCredentials: credentials,
      resolveSlackOAuthPublicBaseUrl,
    });

    expect(
      await invokeHandler(
        app.handler,
        "GET",
        `/api/v1/integrations/slack/oauth/callback?state=${"a".repeat(32)}&code=code`,
      ),
    ).toMatchObject({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
    expect(resolveSlackOAuthPublicBaseUrl).toHaveBeenCalledOnce();
  });
});

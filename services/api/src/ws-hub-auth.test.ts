import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("WebSocket host authentication", () => {
  it("rejects missing, read-only, and mismatched host credentials", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const readOnly = await auth.createServiceAccount({
      name: "reader",
      role: "read-only",
      boundHostId: "a1",
    });
    const bound = await auth.createServiceAccount({
      name: "agent",
      role: "operator",
      boundHostId: "a1",
    });
    const bridge = createPlaneWsBridge();
    const server = createServer();
    const hub = bridge.attach(server, new ControlPlane(), auth);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const url = `ws://127.0.0.1:${address.port}/ws`;

    await expectUnauthorizedUpgrade(url);
    expect(await rejectedRegistration(url, readOnly.apiKey, "a1")).toBe(1008);
    expect(await rejectedRegistration(url, bound.apiKey, "b2")).toBe(1008);

    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
});

async function expectUnauthorizedUpgrade(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("missing-auth timeout")), 3000);
    ws.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      expect(response.statusCode).toBe(401);
      resolve();
    });
    ws.on("error", () => undefined);
  });
}

async function rejectedRegistration(url: string, apiKey: string, hostId: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${apiKey}` } });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "host:register",
          hostId,
          worktrees: [],
          commandProfiles: [],
        }),
      ),
    );
    ws.on("close", (code) => resolve(code));
    ws.on("error", reject);
  });
}

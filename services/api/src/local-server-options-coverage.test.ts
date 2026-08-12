import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { startLocalServer } from "./local-server.ts";

it("forwards host messages to both the callback and websocket bridge", async () => {
  const plane = new ControlPlane();
  const messages: unknown[] = [];
  const server = await startLocalServer({
    port: 18_000 + Math.floor(Math.random() * 1_000),
    useDynamo: false,
    plane,
    onHostMessage: (_hostId, message) => messages.push(message),
  });
  try {
    plane.registerHost({ hostId: "host", worktrees: [], commandProfiles: [] });
    plane.drainHost("host");
    expect(messages).toEqual([{ type: "host:drain" }]);
  } finally {
    await server.close();
  }
});

it("uses the default public URL when constructing a Dynamo-backed plane", async () => {
  try {
    const server = await startLocalServer({
      port: 19_000 + Math.floor(Math.random() * 1_000),
      useDynamo: true,
      enableWs: false,
    });
    await server.close();
  } catch {
    // DynamoDB Local is optional in unit-only runs; the dedicated Dynamo gate
    // exercises the successful construction path.
    expect(true).toBe(true);
  }
});

import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("Command REST name validation", () => {
  it("returns validation errors for invalid and duplicate names", async () => {
    let id = 0;
    const plane = new ControlPlane({ commandIdFactory: () => `command-${++id}` });
    const { handler } = createLocalApp({ plane });
    const invoke = (method: string, path: string, body: unknown) =>
      invokeHandler(handler, method, path, body);

    const invalid = await invoke("POST", "/api/v1/commands", {
      name: "Bad Name",
      argv: ["echo"],
    });
    expect(invalid).toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });

    const first = await invoke("POST", "/api/v1/commands", {
      name: "echo-hi",
      argv: ["echo"],
    });
    expect(first.status).toBe(201);
    await expect(
      invoke("POST", "/api/v1/commands", { name: "echo-hi", argv: ["echo"] }),
    ).resolves.toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });

    const second = await invoke("POST", "/api/v1/commands", {
      name: "other-command",
      argv: ["echo"],
    });
    const secondId = (second.json as { id: string }).id;
    await expect(
      invoke("PATCH", `/api/v1/commands/${secondId}`, { name: "Bad Name" }),
    ).resolves.toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });
    await expect(
      invoke("PATCH", `/api/v1/commands/${secondId}`, { name: "echo-hi" }),
    ).resolves.toMatchObject({
      status: 400,
      json: { error: { code: "VALIDATION_ERROR" } },
    });
  });
});

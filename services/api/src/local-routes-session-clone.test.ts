import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

describe("session clone route", () => {
  it("validates every clone body shape and returns structured route errors", async () => {
    let id = 0;
    const plane = new ControlPlane({ idFactory: () => `session-${++id}` });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    const { handler } = createLocalApp({ plane });
    const clone = (body?: unknown) =>
      invokeHandler(handler, "POST", "/api/v1/sessions/session-1/clone", body);

    expect((await invokeHandler(handler, "GET", "/api/v1/sessions/session-1/clone")).status).toBe(
      404,
    );
    expect((await invokeHandler(handler, "POST", "/api/v1/sessions/missing/clone")).status).toBe(
      404,
    );
    expect(await invokeBadJson(handler, "POST", "/api/v1/sessions/session-1/clone")).toBe(400);

    for (const body of [
      [],
      { extra: true },
      { prompt: "" },
      { prompt: 1 },
      { timeout: 0 },
      { timeout: "30" },
      { priority: Number.POSITIVE_INFINITY },
      { priority: "high" },
    ]) {
      expect((await clone(body)).status).toBe(400);
    }

    expect((await clone()).status).toBe(201);
    expect((await clone({ prompt: "again", timeout: 20, priority: 3 })).json).toMatchObject({
      prompt: "again",
      timeout: 20,
      priority: 3,
    });
  });

  it("returns an internal error when durable clone storage fails", async () => {
    const plane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    plane.state.storage = {
      getSession: async () => plane.state.sessions.get("session-1")!,
      listCommands: async () => {
        throw new Error("unavailable");
      },
      listProviders: async () => [],
      listProviderAccounts: async () => [],
    } as never;

    const response = await invokeHandler(
      createLocalApp({ plane }).handler,
      "POST",
      "/api/v1/sessions/session-1/clone",
    );
    expect(response.status).toBe(500);
  });

  it("maps validation and durable conflicts from clone creation", async () => {
    const validationPlane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(validationPlane);
    validationPlane.createSession(baseSessionBody());
    validationPlane.state.commands.clear();
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: validationPlane }).handler,
          "POST",
          "/api/v1/sessions/session-1/clone",
        )
      ).status,
    ).toBe(400);

    const conflictPlane = new ControlPlane({ idFactory: () => "session-2" });
    seedBaseCommand(conflictPlane);
    conflictPlane.createSession(baseSessionBody());
    const source = conflictPlane.state.sessions.get("session-2")!;
    const command = conflictPlane.state.commands.get("cmd-base")!;
    const concurrentCommand = { ...command, id: "cmd-concurrent", name: "concurrent" };
    conflictPlane.state.commands.set(concurrentCommand.id, concurrentCommand);
    conflictPlane.state.storage = {
      getSession: async () => source,
      listCommands: async () => [command],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      createSession: async (session: typeof source) => ({ created: false, session }),
    } as never;
    conflictPlane.state.sessions.clear();
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: conflictPlane }).handler,
          "POST",
          "/api/v1/sessions/session-2/clone",
        )
      ).status,
    ).toBe(409);
    expect(conflictPlane.state.commands.get(concurrentCommand.id)).toEqual(concurrentCommand);
  });
});

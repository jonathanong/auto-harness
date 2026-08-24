import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
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
    expect((await clone(null)).status).toBe(201);
    expect((await clone({ prompt: "again", timeout: 20, priority: 3 })).json).toMatchObject({
      prompt: "again",
      timeout: 20,
      priority: 3,
    });
    expect(
      (await plane.listAuditLogs({ action: "session:clone", outcome: "success" })).items,
    ).toHaveLength(3);
  });

  it("fails closed when appending a clone audit record fails", async () => {
    let id = 0;
    const plane = new ControlPlane({ idFactory: () => `session-${++id}` });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    let assignmentCalls = 0;
    plane.requestAssignment = async () => void assignmentCalls++;
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane }).handler,
          "POST",
          "/api/v1/sessions/session-1/clone",
        )
      ).status,
    ).toBe(500);
    expect(assignmentCalls).toBe(0);
  });

  it("audits durable read failures and enforces clone repository scope", async () => {
    const unavailablePlane = new ControlPlane({ idFactory: () => "session-1" });
    unavailablePlane.state.storage = {
      getSession: async () => {
        throw new Error("unavailable");
      },
      putAuditLog: async () => undefined,
    } as never;
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: unavailablePlane }).handler,
          "POST",
          "/api/v1/sessions/session-1/clone",
        )
      ).status,
    ).toBe(500);

    const plane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({
      name: "allowed",
      role: "operator",
      allowedRepositoryIds: ["repo-1"],
    });
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane, authService: auth }).handler,
          "POST",
          "/api/v1/sessions/session-1/clone",
          undefined,
          { authorization: `Bearer ${apiKey}` },
        )
      ).status,
    ).toBe(201);
    const { apiKey: deniedApiKey } = await auth.createServiceAccount({
      name: "scoped",
      role: "operator",
      allowedRepositoryIds: ["other-repository"],
    });
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane, authService: auth }).handler,
          "POST",
          "/api/v1/sessions/session-1/clone",
          undefined,
          { authorization: `Bearer ${deniedApiKey}` },
        )
      ).status,
    ).toBe(404);
    expect(
      (await plane.listAuditLogs({ action: "session:clone", outcome: "denied" })).items,
    ).toHaveLength(1);
  });

  it("returns an internal error when durable clone storage fails", async () => {
    const plane = new ControlPlane({ idFactory: () => "session-1" });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    plane.state.storage = {
      getSession: async () => plane.state.sessions.get("session-1")!,
      putAuditLog: async () => undefined,
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
      getRepository: async () => null,
      putAuditLog: async () => undefined,
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

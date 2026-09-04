import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  deterministicPlane,
  finishedLoggedSessionPlane,
  registerFixtureHost,
} from "./control-plane-prior-context-test-helpers.ts";
import {
  loadPriorSessionContextDurable,
  loadPriorSessionContextLocal,
} from "./control-plane-prior-context.ts";

describe("loadPriorSessionContextLocal", () => {
  it("returns null for an unknown source session", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    expect(loadPriorSessionContextLocal(plane.state, "missing")).toBeNull();
  });

  it("returns null for a session that exists but never logged anything", () => {
    const plane = deterministicPlane();
    plane.createCommand({ id: "cmd", name: "echo", argv: ["echo"], appendPrompt: true });
    registerFixtureHost(plane, "host");
    plane.createSession({
      repositoryId: "repo",
      prompt: "first run",
      target: { commandId: "cmd" },
      timeout: 30,
    });
    plane.assignQueued();
    const session = plane.getSession("s1")!;
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "s1",
      worktreeId: session.worktreeId!,
      attemptId: session.attemptId!,
      status: "completed",
    });
    expect(plane.state.logs.has("s1")).toBe(false);
    expect(loadPriorSessionContextLocal(plane.state, "s1")).toBeNull();
  });

  it("renders the transcript of a terminal source session", () => {
    const plane = finishedLoggedSessionPlane("did the thing");
    const context = loadPriorSessionContextLocal(plane.state, "s1");
    expect(context).toMatchObject({ sourceSessionId: "s1", truncated: false });
    expect(context!.content).toContain("did the thing");
  });
});

describe("loadPriorSessionContextDurable", () => {
  it("falls back to the local read when there is no durable storage configured", async () => {
    const plane = finishedLoggedSessionPlane("durable path");
    const context = await loadPriorSessionContextDurable(plane.state, "s1");
    expect(context).toMatchObject({ sourceSessionId: "s1" });
    expect(context!.content).toContain("durable path");
  });

  it("returns null instead of throwing when the source session does not exist", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    expect(await loadPriorSessionContextDurable(plane.state, "missing")).toBeNull();
  });

  it("returns null instead of throwing when the durable read fails", async () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.state.storage = {
      getSession: async () => {
        throw new Error("dynamo unavailable");
      },
    } as never;
    expect(await loadPriorSessionContextDurable(plane.state, "s1")).toBeNull();
  });
});

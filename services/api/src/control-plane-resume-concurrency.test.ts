import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

describe("durable resume concurrency", () => {
  it("validates a resume source and omits an absent CLI resume reference", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `resume-${++id}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    const source = plane.state.sessions.get("resume-1")!;
    Object.assign(source, { status: "completed", hostId: "host-1", concurrencyId: "resume-key" });
    let durableCreates = 0;
    plane.state.storage = {
      createSession: async (session: SessionRecord) => {
        durableCreates += 1;
        if (durableCreates === 1) return { created: true, session };
        return {
          created: false,
          session: { ...session, id: "durable-active", status: "queued" },
        };
      },
    } as never;

    await expect(plane.resumeSessionDurable(source.id)).resolves.toMatchObject({
      ok: true,
      created: true,
      session: {
        id: "resume-2",
        pinnedHostId: "host-1",
        pinExpiresAt: "2026-01-01T01:00:00.000Z",
      },
    });
    expect(plane.getSession("resume-2")).not.toHaveProperty("cliResumeRef");

    // `resume-2` is a process-local active cache entry. Durable storage is
    // the authority: another API worker may own a different active resume.
    await expect(plane.resumeSessionDurable(source.id)).resolves.toMatchObject({
      ok: true,
      created: false,
      session: { id: "durable-active" },
    });
    expect(durableCreates).toBe(2);

    plane.state.sessions.set("active-source", {
      ...source,
      id: "active-source",
      status: "queued",
    });
    await expect(plane.resumeSessionDurable("active-source")).resolves.toMatchObject({
      ok: false,
      error: "source session must be terminal before resume",
    });
  });

  it("maps bounded storage conflicts and preserves unexpected failures", async () => {
    const plane = new ControlPlane({
      idFactory: () => "conflict-session",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    const source = plane.state.sessions.get("conflict-session")!;
    Object.assign(source, { status: "completed", hostId: "host-1", concurrencyId: "key" });

    const collision = Object.assign(new Error("collision"), { name: "SessionIdCollisionError" });
    plane.state.storage = { createSession: async () => Promise.reject(collision) } as never;
    await expect(plane.createSessionDurable(baseSessionBody())).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });
    await expect(plane.resumeSessionDurable(source.id)).resolves.toEqual({
      ok: false,
      error: "session creation conflicted; retry the request",
    });

    const exhausted = Object.assign(new Error("exhausted"), {
      name: "CreateSessionRetryExhaustedError",
    });
    plane.state.storage = { createSession: async () => Promise.reject(exhausted) } as never;
    await expect(plane.createSessionDurable(baseSessionBody())).resolves.toMatchObject({
      ok: false,
      code: "CONFLICT",
    });

    const unexpected = new Error("storage unavailable");
    plane.state.storage = { createSession: async () => Promise.reject(unexpected) } as never;
    await expect(plane.createSessionDurable(baseSessionBody())).rejects.toBe(unexpected);
    await expect(plane.resumeSessionDurable(source.id)).rejects.toBe(unexpected);
  });
});

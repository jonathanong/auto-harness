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
    Object.assign(source, { status: "completed", hostId: "host-1" });
    plane.state.storage = {
      createSession: async (session: SessionRecord) => ({ created: true, session }),
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
});

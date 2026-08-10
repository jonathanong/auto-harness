import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("listSessionsPage", () => {
  it("pages newest-first with opaque cursor and filters", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `s${++n}`,
      now: (() => {
        let t = 0;
        return () => new Date(1_700_000_000_000 + t++ * 1000).toISOString();
      })(),
      shardCount: 1,
    });
    plane.createCommand({ id: "cmd-echo", name: "echo", argv: ["echo"], providerId: null });
    for (let i = 0; i < 5; i++) {
      expect(
        plane.createSession({
          repositoryId: "r1",
          prompt: `p-${i}`,
          target: { commandId: "cmd-echo" },
          timeout: 10,
        }).ok,
      ).toBe(true);
    }
    plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["echo"],
    });
    const assigned = plane.assignQueued();
    for (const a of assigned) {
      plane.handleHostMessage({ type: "session:ack", sessionId: a.session.id });
    }

    const page1 = plane.listSessionsPage({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = plane.listSessionsPage({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);

    const rest = plane.listSessionsPage({ limit: 10, cursor: page2.nextCursor! });
    expect(rest.items.length).toBeGreaterThanOrEqual(1);
    expect(rest.nextCursor).toBeNull();

    const byHost = plane.listSessionsPage({ hostId: "a1", limit: 50 });
    expect(byHost.items.every((s) => s.hostId === "a1")).toBe(true);

    const byQ = plane.listSessionsPage({ q: "p-0", limit: 50 });
    expect(byQ.items.some((s) => s.prompt === "p-0")).toBe(true);

    const byStatus = plane.listSessionsPage({ status: "queued", limit: 50 });
    expect(byStatus.items.every((s) => s.status === "queued")).toBe(true);
    const allStatus = plane.listSessionsPage({ status: "all", limit: 50 });
    expect(allStatus.items.length).toBeGreaterThan(byStatus.items.length);

    // A cursor that decodes without an embedded newline is treated as invalid and ignored.
    const garbageCursor = Buffer.from("no-newline-here", "utf8").toString("base64url");
    const ignored = plane.listSessionsPage({ cursor: garbageCursor, limit: 50 });
    expect(ignored.items.length).toBe(5);
  });
});

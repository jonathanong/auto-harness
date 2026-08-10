import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  InvalidSessionCursorError,
  InvalidSessionListQueryError,
} from "./control-plane-sessions-page.ts";

function makePlane(): ControlPlane {
  let n = 0;
  return new ControlPlane({
    idFactory: () => `s${++n}`,
    sessionCursorSecret: "test-session-cursor-secret",
    now: (() => {
      let t = 0;
      return () => new Date(1_700_000_000_000 + t++ * 1000).toISOString();
    })(),
    shardCount: 1,
  });
}

function seedSessions(plane: ControlPlane): void {
  plane.createCommand({ id: "cmd-echo", name: "echo", argv: ["echo"], providerId: null });
  for (let i = 0; i < 7; i++) {
    expect(
      plane.createSession({
        repositoryId: i === 6 ? "r2" : "r1",
        prompt: `p-${i}`,
        target: { commandId: "cmd-echo" },
        timeout: 10,
        priority: i === 0 ? 50 : i,
        ...(i === 0 ? { concurrencyId: "nightly-pr-123" } : {}),
      }).ok,
    ).toBe(true);
  }
  plane.state.sessions.get("s1")!.hostId = "host-a";
  plane.state.sessions.get("s2")!.hostId = "host-b";
  plane.state.sessions.get("s3")!.hostId = "host-a";
  plane.state.sessions.get("s4")!.status = "completed";
  plane.state.sessions.get("s2")!.scheduleId = "schedule-a";
}

describe("listSessionsPage", () => {
  it("pages newest-first with a cursor bound to filters, sort, and scope", () => {
    const plane = makePlane();
    seedSessions(plane);

    const page1 = plane.listSessionsPage({ limit: 2 });
    expect(page1.items.map((session) => session.id)).toEqual(["s7", "s6"]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = plane.listSessionsPage({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((session) => session.id)).toEqual(["s5", "s4"]);
    expect(page2.nextCursor).toBeTruthy();

    const scoped1 = plane.listSessionsPage({
      repositoryId: "r1",
      scope: { repositoryIds: ["r1"] },
      limit: 2,
    });
    expect(scoped1.items).toHaveLength(2);
    expect(scoped1.items.every((session) => session.repositoryId === "r1")).toBe(true);
    const scoped2 = plane.listSessionsPage({
      repositoryId: "r1",
      scope: { repositoryIds: ["r1"] },
      limit: 2,
      cursor: scoped1.nextCursor!,
    });
    expect(scoped2.items).toHaveLength(2);
    expect(scoped2.items.every((session) => session.repositoryId === "r1")).toBe(true);

    expect(() =>
      plane.listSessionsPage({
        repositoryId: "r1",
        scope: { repositoryIds: ["r2"] },
        limit: 2,
        cursor: scoped1.nextCursor!,
      }),
    ).toThrow(InvalidSessionCursorError);
    expect(() =>
      plane.listSessionsPage({ sort: "oldest", limit: 2, cursor: page1.nextCursor! }),
    ).toThrow(InvalidSessionCursorError);
    const tampered = `${page1.nextCursor!.startsWith("a") ? "b" : "a"}${page1.nextCursor!.slice(1)}`;
    expect(() => plane.listSessionsPage({ limit: 2, cursor: tampered })).toThrow(
      InvalidSessionCursorError,
    );
  });

  it("applies filters before the limit and supports all documented sorts", () => {
    const plane = makePlane();
    seedSessions(plane);

    expect(
      plane
        .listSessionsPage({ status: "completed", repositoryId: "r1", limit: 50 })
        .items.map((session) => session.id),
    ).toEqual(["s4"]);
    expect(
      plane.listSessionsPage({ hostId: "host-a", limit: 50 }).items.map((session) => session.id),
    ).toEqual(["s3", "s1"]);
    expect(
      plane
        .listSessionsPage({ concurrencyId: "nightly-pr-123", limit: 50 })
        .items.map((session) => session.id),
    ).toEqual(["s1"]);
    expect(
      plane
        .listSessionsPage({ scheduleId: "schedule-a", limit: 50 })
        .items.map((session) => session.id),
    ).toEqual(["s2"]);

    expect(
      plane.listSessionsPage({ sort: "oldest", limit: 3 }).items.map((session) => session.id),
    ).toEqual(["s1", "s2", "s3"]);
    expect(
      plane
        .listSessionsPage({ sort: "priority_desc", limit: 3 })
        .items.map((session) => session.id),
    ).toEqual(["s1", "s7", "s6"]);
    expect(
      plane.listSessionsPage({ sort: "priority_asc", limit: 3 }).items.map((session) => session.id),
    ).toEqual(["s2", "s3", "s4"]);
  });

  it("rejects invalid page limits and statuses", () => {
    const plane = makePlane();
    seedSessions(plane);

    for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => plane.listSessionsPage({ limit })).toThrow(InvalidSessionListQueryError);
    }
    expect(() => plane.listSessionsPage({ status: "not-a-status" })).toThrow(
      InvalidSessionListQueryError,
    );
    expect(() => plane.listSessionsPage({ status: "all" })).not.toThrow();
  });
});

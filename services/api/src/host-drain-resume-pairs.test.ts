import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

/**
 * Paired drain/resume operator table.
 *
 * `drain` and `resume` are inverse operators over the same host state, but PR
 * #762 shipped a bug (`resume` 409ing a host that was not draining) precisely
 * because their expectations were written in separate, independently-passing
 * test cases, with nothing forcing anyone to state what the inverse of a given
 * drain outcome actually is. Every row below names ONE starting host state and
 * BOTH operators' real, verified-by-running-it outcome for it, so an asymmetry
 * is visible on the page instead of hidden across files.
 *
 * Table A: the in-memory path (no durable storage configured) -- drainHost /
 * resumeHost. Table B: the durable, storage-backed path used in production
 * (drainHostDurable / resumeHostDurable against a stubbed DynamoDB-shaped
 * storage) -- the exact path PR #762's bug lived in.
 */

type Outcome = { status: number; body: Record<string, unknown> };

async function callRoute(plane: ControlPlane, path: string): Promise<Outcome> {
  const { handler } = createLocalApp({ plane });
  const res = await invokeHandler(handler, "POST", path, { hostId: "a1" });
  return { status: res.status, body: (res.json ?? {}) as Record<string, unknown> };
}

function expectOutcome(actual: Outcome, expected: Outcome): void {
  expect(actual.status).toBe(expected.status);
  expect(actual.body).toMatchObject(expected.body);
}

const WORKTREE = { id: "wt-1", name: "wt-1", hostId: "a1", repositoryId: "r1", path: "/w" };

// ---------------------------------------------------------------------------
// Table A: in-memory (no storage) -- drainHost / resumeHost
// ---------------------------------------------------------------------------

function inMemoryPlane(opts: {
  draining?: true;
  worktreeStatus?: "idle" | "busy";
  online?: boolean;
  withRunningSession?: boolean;
}): ControlPlane {
  const plane = new ControlPlane({ idFactory: () => "sess-1" });
  if (opts.withRunningSession) {
    plane.seedWorktree({
      ...WORKTREE,
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "sess-1",
    });
    plane.state.sessions.set("sess-1", {
      id: "sess-1",
      repositoryId: "r1",
      prompt: "p",
      targetLabel: "t",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "t",
      hostId: "a1",
      worktreeId: "wt-1",
      ackReceivedAt: "t",
    } as never);
  } else {
    plane.seedWorktree({
      ...WORKTREE,
      labels: [],
      status: opts.worktreeStatus ?? "idle",
      online: opts.online ?? true,
      currentSessionId: null,
    });
  }
  plane.registerHost({
    hostId: "a1",
    worktrees: [{ ...WORKTREE, labels: [] }],
    replaceExisting: true,
    // A reconnecting daemon must re-report any session it still considers
    // running, or registration's reconcile pass requeues it as abandoned.
    ...(opts.withRunningSession ? { runningSessions: ["sess-1"] } : {}),
    ...(opts.draining ? { draining: true } : {}),
  });
  return plane;
}

type RowA = {
  name: string;
  build: () => ControlPlane;
  drain: Outcome;
  resume: Outcome;
  afterDrain?: (plane: ControlPlane) => void;
  afterResume?: (plane: ControlPlane) => void;
};

const tableA: RowA[] = [
  {
    // Same contract PR #762 fixed (resume-while-not-draining is a no-op, not
    // a conflict), but the in-memory resumeHost never had that bug: the
    // lease-owner guard it takes an explicit `connectionId` for is skipped
    // entirely on every route call (the route never passes one). The bug
    // itself lived only in the durable path -- see Table B below.
    name: "not draining",
    build: () => inMemoryPlane({}),
    drain: { status: 200, body: { ok: true } },
    resume: { status: 200, body: { ok: true } },
    afterDrain: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(false),
    afterResume: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(true),
  },
  {
    name: "already draining",
    build: () => inMemoryPlane({ draining: true, online: false }),
    drain: { status: 200, body: { ok: true } },
    resume: { status: 200, body: { ok: true } },
    afterDrain: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(false),
    afterResume: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(true),
  },
  {
    name: "unknown host (never registered)",
    build: () => new ControlPlane(),
    drain: { status: 200, body: { ok: true } },
    resume: { status: 200, body: { ok: true } },
  },
  {
    name: "busy worktree with a live running session",
    build: () => inMemoryPlane({ withRunningSession: true }),
    drain: { status: 200, body: { ok: true, runningSessionIds: ["sess-1"] } },
    resume: { status: 200, body: { ok: true } },
    // Drain and resume both only ever touch *idle* worktrees; a busy one keeps
    // whatever online value it already had all the way through.
    afterDrain: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(true),
    afterResume: (plane) => expect(plane.getWorktree("wt-1")?.online).toBe(true),
  },
];

describe("paired drain/resume operator table: in-memory", () => {
  it.each(tableA)("$name", async ({ build, drain, resume, afterDrain, afterResume }) => {
    const drainPlane = build();
    expectOutcome(await callRoute(drainPlane, "/api/v1/hosts/drain"), drain);
    afterDrain?.(drainPlane);

    const resumePlane = build();
    expectOutcome(await callRoute(resumePlane, "/api/v1/hosts/resume"), resume);
    afterResume?.(resumePlane);
  });
});

// ---------------------------------------------------------------------------
// Table B: durable storage path -- drainHostDurable / resumeHostDurable.
// Storage stubs mirror the real DynamoDB adapter shapes proven in
// db/dynamo-storage-locks-coverage.test.ts (a missing lock item reads back as
// `{ connectionId: null, draining: false }`, never a distinct "not found").
// ---------------------------------------------------------------------------

type Calls = { marked: boolean; cleared: boolean };

function durablePlane(lock: { connectionId: string | null; draining: boolean }): {
  plane: ControlPlane;
  calls: Calls;
} {
  const calls: Calls = { marked: false, cleared: false };
  const plane = new ControlPlane({
    storage: {
      getHostLock: async () => lock.connectionId,
      getHostLockState: async () => lock,
      markHostDraining: async () => ((calls.marked = true), true),
      clearHostDraining: async () => ((calls.cleared = true), true),
      setWorktreeOnlineFenced: async () => true,
      putAuditLog: async () => {
        /* not under test */
      },
    } as never,
  });
  // A stale local cache (e.g. a warm container that served an earlier drain)
  // must not override what the durable lock says; seeding it here proves
  // resume reconciles from the durable read rather than trusting the cache.
  plane.state.drainingHosts.add("a1");
  return { plane, calls };
}

type RowB = {
  name: string;
  lock: { connectionId: string | null; draining: boolean };
  drain: Outcome;
  resume: Outcome;
  afterDrain?: (calls: Calls) => void;
  afterResume?: (plane: ControlPlane, calls: Calls) => void;
};

const tableB: RowB[] = [
  {
    name: "known host, live lease owner, not draining",
    lock: { connectionId: "owner", draining: false },
    drain: { status: 200, body: { ok: true } },
    resume: { status: 200, body: { ok: true } },
    afterDrain: (calls) => expect(calls.marked).toBe(true),
    afterResume: (plane, calls) => {
      // Nothing durable to clear means no fenced write is even attempted,
      // and the stale local cache still reconciles to false either way.
      expect(calls.cleared).toBe(false);
      expect(plane.isDraining("a1")).toBe(false);
    },
  },
  {
    name: "known host, live lease owner, already draining",
    lock: { connectionId: "owner", draining: true },
    drain: { status: 200, body: { ok: true } },
    resume: { status: 200, body: { ok: true } },
    afterDrain: (calls) => expect(calls.marked).toBe(true),
    afterResume: (plane, calls) => {
      expect(calls.cleared).toBe(true);
      expect(plane.isDraining("a1")).toBe(false);
    },
  },
  {
    // This is PR #762's exact production shape, verified: sabotaging
    // resumeHostDurable back to its pre-#762 guard order (checking the lease
    // owner before the not-draining no-op) makes exactly this row fail with
    // "expected 409 to be 200" -- and does NOT fail the "known host, live
    // lease owner" rows above, because they have a resolvable owner and the
    // old bug only bites when the owner is unknown. That is also the
    // "already resolved" shape resumeHostDurable's own comment names as the
    // reason its no-op check must run first: a cold REST container with no
    // cached hostConnection reads exactly this from a real Dynamo lock row.
    name: "no lock row at all -- unresolvable lease owner, not draining",
    lock: { connectionId: null, draining: false },
    // ASYMMETRY the table exposes (see PR description -- not fixed here): a
    // completely unregistered hostId and a known-but-owner-unknown host read
    // back from Dynamo as the exact same shape; there is no distinct "not
    // found" case. drain needs a fenced owner to write and has none, so it
    // 409s. resume's not-draining branch intentionally runs before any owner
    // is needed (that is the #762 fix), so it no-ops 200. Same input, two
    // different verdicts, and neither is simply "wrong" in isolation: making
    // resume 404/409 here would revert #762 for every cold-container retry.
    drain: { status: 409, body: { error: { code: "CONFLICT" } } },
    resume: { status: 200, body: { ok: true } },
  },
  {
    name: "durable lock says draining, but no live lease owner is recorded",
    lock: { connectionId: null, draining: true },
    // Symmetric this time: both operators need a fenced owner to do real
    // work here, and neither has one.
    drain: { status: 409, body: { error: { code: "CONFLICT" } } },
    resume: { status: 409, body: { error: { code: "CONFLICT" } } },
  },
];

describe("paired drain/resume operator table: durable storage", () => {
  it.each(tableB)("$name", async ({ lock, drain, resume, afterDrain, afterResume }) => {
    const forDrain = durablePlane(lock);
    expectOutcome(await callRoute(forDrain.plane, "/api/v1/hosts/drain"), drain);
    afterDrain?.(forDrain.calls);

    const forResume = durablePlane(lock);
    expectOutcome(await callRoute(forResume.plane, "/api/v1/hosts/resume"), resume);
    afterResume?.(forResume.plane, forResume.calls);
  });
});

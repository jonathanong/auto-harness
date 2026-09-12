import { expect, it, vi } from "vitest";

import {
  releaseTimedOutProviderAccountLease as releaseTimedOutLease,
  releaseTimedOutProviderAccountLeasesForHost,
} from "./control-plane-provider-account-leases.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

function timedOut(
  id: string,
  providerAccountLease?: SessionRecord["providerAccountLease"],
): SessionRecord {
  return {
    id,
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "timed_out",
    queueShard: 0,
    createdAt: "now",
    attemptId: "attempt",
    timedOutHostId: "host",
    timedOutAssignmentConnectionId: "connection",
    ...(providerAccountLease ? { providerAccountLease } : {}),
  };
}

it("releases timeout-preserved host and provider-account leases only after their eligible cleanup paths", async () => {
  const state = createControlPlaneState();
  const hostOnly = timedOut("host-only");
  const lease = {
    concurrencyId: "acct:account:0",
    providerAccountId: "account",
    slot: 0,
    attemptId: "attempt",
  };
  const localLease = timedOut("local-lease", lease);
  const durableLease = timedOut("durable-lease", { ...lease, concurrencyId: "acct:account:1" });
  state.providerAccountLeases.set(lease.concurrencyId, {
    sessionId: localLease.id,
    hostId: "host",
    ...lease,
  });
  state.providerAccountLeases.set(durableLease.providerAccountLease!.concurrencyId, {
    sessionId: durableLease.id,
    hostId: "host",
    ...durableLease.providerAccountLease!,
  });
  const releaseTimedOutHostAssignment = vi.fn(async () => true);
  const releaseTimedOutProviderAccountLease = vi.fn(async () => true);
  state.storage = { releaseTimedOutHostAssignment, releaseTimedOutProviderAccountLease } as never;

  await expect(releaseTimedOutLease(state, hostOnly, { status: "completed" })).resolves.toBe(true);
  await expect(releaseTimedOutLease(state, durableLease)).resolves.toBe(true);
  delete state.storage;
  await expect(releaseTimedOutLease(state, localLease)).resolves.toBe(true);
  expect(releaseTimedOutHostAssignment).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: hostOnly.id, result: { status: "completed" } }),
  );
  expect(releaseTimedOutProviderAccountLease).toHaveBeenCalledWith(
    expect.objectContaining({ concurrencyId: "acct:account:1" }),
  );
  expect(state.providerAccountLeases.has(lease.concurrencyId)).toBe(false);

  state.sessions.set(hostOnly.id, timedOut(hostOnly.id));
  expect(await releaseTimedOutProviderAccountLeasesForHost(state, "host")).toEqual([hostOnly.id]);
});

it("records a completion result through the local timeout fallback", async () => {
  const state = createControlPlaneState();
  const session = timedOut("local-result", {
    concurrencyId: "acct:account:0",
    providerAccountId: "account",
    slot: 0,
    attemptId: "attempt",
  });
  state.providerAccountLeases.set("acct:account:0", {
    sessionId: session.id,
    hostId: "host",
    providerAccountId: "account",
    slot: 0,
    attemptId: "attempt",
  });
  state.storage = {} as never;

  const result = { status: "completed" as const };
  await expect(releaseTimedOutLease(state, session, result)).resolves.toBe(true);
  expect(session.result).toEqual(result);
});

it("keeps a timed-out lease when host cleanup loses its race", async () => {
  const state = createControlPlaneState();
  const session = timedOut("race", {
    concurrencyId: "acct:account:0",
    providerAccountId: "account",
    slot: 0,
    attemptId: "attempt",
  });
  state.storage = {
    listActiveSessionsByHost: async () => [session],
    releaseTimedOutProviderAccountLease: async () => false,
  } as never;

  await expect(releaseTimedOutProviderAccountLeasesForHost(state, "host")).resolves.toEqual([]);
  expect(session.providerAccountLease).toBeDefined();
});

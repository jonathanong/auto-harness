import { describe, expect, it } from "vitest";

import { ingestUsage, ingestUsageDurable } from "./control-plane-usage.ts";
import { aggregateUsage, usageKindConflicts, validateUsage } from "./usage.ts";

const base = {
  sessionId: "s1",
  repositoryId: "r1",
  attemptId: "a1",
  worktreeId: "w1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  source: "cli" as const,
  observedAt: "2026-01-01T00:00:00.000Z",
};

describe("session usage", () => {
  it("deduplicates deltas and is order independent", () => {
    const records = [
      { ...base, kind: "delta" as const, sequence: 2, outputTokens: "3" },
      { ...base, kind: "delta" as const, sequence: 1, inputTokens: "5" },
      { ...base, kind: "delta" as const, sequence: 1, inputTokens: "5" },
    ];
    expect(aggregateUsage(records)).toMatchObject({
      inputTokens: "5",
      outputTokens: "3",
      reportCount: 2,
    });
  });

  it("uses cumulative values instead of double counting mixed modes", () => {
    const records = [
      { ...base, kind: "delta" as const, sequence: 1, inputTokens: "10" },
      { ...base, kind: "cumulative" as const, sequence: 2, inputTokens: "12" },
    ];
    expect(aggregateUsage(records).inputTokens).toBe("12");
  });

  it("keeps mixed currencies separate", () => {
    const records = [
      { ...base, kind: "delta" as const, sequence: 1, costMicros: "4", currency: "USD" },
      {
        ...base,
        attemptId: "a2",
        kind: "delta" as const,
        sequence: 1,
        costMicros: "6",
        currency: "EUR",
      },
    ];
    expect(aggregateUsage(records)).toMatchObject({
      costMicros: "0",
      costMicrosByCurrency: { USD: "4", EUR: "6" },
    });
  });

  it("does not expose a scalar cost when known and unknown currencies mix", () => {
    const records = [
      { ...base, kind: "delta" as const, sequence: 1, costMicros: "4", currency: "USD" },
      { ...base, attemptId: "a2", kind: "delta" as const, sequence: 1, costMicros: "6" },
    ];
    expect(aggregateUsage(records)).toMatchObject({
      costMicros: "0",
      costMicrosByCurrency: { USD: "4", UNKNOWN: "6" },
    });
  });

  it("rejects unbounded, empty, or non-CLI reports", () => {
    expect(validateUsage({ ...base, kind: "delta", sequence: 1, source: "log" })).toBe(false);
    expect(validateUsage({ ...base, kind: "delta", sequence: 1 })).toBe(false);
    expect(
      validateUsage({ ...base, kind: "delta", sequence: 1, inputTokens: "1".repeat(31) }),
    ).toBe(false);
  });

  it("detects a kind change within one attempt", () => {
    const records = [{ ...base, kind: "delta" as const, sequence: 1, inputTokens: "1" }];
    expect(usageKindConflicts(records, "cumulative")).toBe(true);
    expect(usageKindConflicts(records, "delta")).toBe(false);
  });

  it("treats exact duplicates as idempotent but rejects a kind conflict", () => {
    const state = {
      storage: undefined,
      sessions: new Map([
        ["s1", { id: "s1", repositoryId: "r1", attemptId: "a1", worktreeId: "w1" }],
      ]),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsage>[0];
    const report = {
      type: "session:usage",
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta",
        sequence: 1,
        inputTokens: "2",
        source: "cli",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(ingestUsage(state, report as Parameters<typeof ingestUsage>[1])).toEqual({ ok: true });
    expect(ingestUsage(state, report as Parameters<typeof ingestUsage>[1])).toEqual({ ok: true });
    expect(state.usageRecords.size).toBe(1);
    expect(
      ingestUsage(state, {
        ...report,
        usage: { ...report.usage, kind: "cumulative" },
      } as Parameters<typeof ingestUsage>[1]),
    ).toEqual({ ok: false, error: "usage report kind conflicts with this attempt" });
  });

  it("rejects durable reports without a host connection fence", async () => {
    const session = { id: "s1", repositoryId: "r1", attemptId: "a1", worktreeId: "w1" };
    const state = {
      storage: { getSession: async () => session },
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsageDurable>[0];
    const report = {
      type: "session:usage",
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta",
        sequence: 1,
        inputTokens: "2",
        source: "cli",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    await expect(
      ingestUsageDurable(state, report as Parameters<typeof ingestUsageDurable>[1]),
    ).resolves.toEqual({
      ok: false,
      error: "usage report requires host connection fence",
    });
  });

  it("does not turn a concurrent durable kind conflict into a duplicate", async () => {
    const session = { id: "s1", repositoryId: "r1", attemptId: "a1", worktreeId: "w1" };
    const conflicting = {
      ...base,
      kind: "cumulative" as const,
      sequence: 1,
      inputTokens: "2",
    };
    let listCalls = 0;
    const state = {
      storage: {
        getSession: async () => session,
        listUsageRecords: async () => (listCalls++ === 0 ? [] : [conflicting]),
        putUsageRecord: async () => false,
      },
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsageDurable>[0];
    const report = {
      type: "session:usage",
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta",
        sequence: 1,
        inputTokens: "2",
        source: "cli",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    await expect(
      ingestUsageDurable(state, report as Parameters<typeof ingestUsageDurable>[1], {
        hostId: "h1",
        connectionId: "c1",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "usage report kind conflicts with this attempt",
    });
  });
});

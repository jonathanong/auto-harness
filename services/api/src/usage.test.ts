/* eslint-disable max-lines -- usage ingestion cases share one authoritative report fixture. */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { ingestUsage, ingestUsageDurable, usageAggregate } from "./control-plane-usage.ts";
import {
  aggregateUsage,
  costFromRates,
  isDecimal,
  usageKindConflicts,
  validateUsage,
} from "./usage.ts";

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

  it("does not treat unpriced usage as an unknown-currency cost", () => {
    const records = [
      { ...base, kind: "delta" as const, sequence: 1, inputTokens: "2" },
      {
        ...base,
        attemptId: "a2",
        kind: "delta" as const,
        sequence: 1,
        costMicros: "4",
        currency: "USD",
      },
    ];
    expect(aggregateUsage(records)).toMatchObject({
      costMicros: "4",
      currency: "USD",
      costMicrosByCurrency: { USD: "4" },
    });
  });

  it("rejects unbounded, empty, or non-CLI reports", () => {
    expect(validateUsage({ ...base, kind: "delta", sequence: 1, source: "log" })).toBe(false);
    expect(validateUsage({ ...base, kind: "delta", sequence: 1 })).toBe(false);
    expect(
      validateUsage({ ...base, kind: "delta", sequence: 1, inputTokens: "1".repeat(31) }),
    ).toBe(false);
  });

  it("accepts only non-negative decimal counters and a valid CLI timestamp", () => {
    const valid = {
      kind: "cumulative",
      sequence: 0,
      inputTokens: "0",
      source: "cli",
      observedAt: "2026-02-28T12:34:56Z",
      currency: "USD",
    };
    expect(isDecimal("0")).toBe(true);
    expect(isDecimal("12")).toBe(true);
    expect(isDecimal("01")).toBe(false);
    expect(isDecimal("-1")).toBe(false);
    expect(validateUsage(valid)).toBe(true);
    expect(validateUsage({ ...valid, kind: "other" })).toBe(false);
    expect(validateUsage({ ...valid, sequence: -1 })).toBe(false);
    expect(validateUsage({ ...valid, sequence: 1.5 })).toBe(false);
    expect(validateUsage({ ...valid, observedAt: "2026-02-28T25:34:56Z" })).toBe(false);
    expect(validateUsage({ ...valid, currency: "usd" })).toBe(false);
    expect(validateUsage({ ...valid, inputTokens: "01" })).toBe(false);
  });

  it("uses the newest cumulative report and leaves empty aggregates unpriced", () => {
    expect(aggregateUsage([])).toMatchObject({
      sessionCount: 0,
      reportCount: 0,
      costMicros: "0",
      costMicrosByCurrency: {},
    });
    expect(
      aggregateUsage([
        {
          ...base,
          kind: "cumulative",
          sequence: 1,
          inputTokens: "2",
          costMicros: "5",
          currency: "USD",
        },
        {
          ...base,
          kind: "cumulative",
          sequence: 2,
          inputTokens: "3",
          costMicros: "7",
          currency: "USD",
        },
      ]),
    ).toMatchObject({
      inputTokens: "3",
      reportCount: 1,
      costMicros: "7",
      currency: "USD",
    });
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

  it("reports a missing session and directs durable in-memory callers to await", () => {
    const missing = {
      storage: undefined,
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsage>[0];
    const report = {
      type: "session:usage" as const,
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta" as const,
        sequence: 1,
        inputTokens: "2",
        source: "cli" as const,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(ingestUsage(missing, report)).toEqual({ ok: false, error: "session not found" });
    missing.sessions.set("s1", {
      id: "s1",
      repositoryId: "r1",
      attemptId: "a1",
      worktreeId: "w1",
    } as never);
    missing.storage = {} as never;
    expect(ingestUsage(missing, report)).toEqual({
      ok: false,
      error: "durable usage ingestion requires await",
    });
  });

  it("attributes in-memory reports from the assigned route and computes configured cost", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.state.sessions.set("s1", {
      id: "s1",
      repositoryId: "r1",
      attemptId: "a1",
      worktreeId: "w1",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "acct-1",
        commandId: "cmd-1",
        hostId: "host-1",
        worktreeId: "w1",
        attemptId: "a1",
      },
    } as never);
    plane.state.providerAccounts.set("acct-1", { id: "acct-1", providerId: "prov-1" } as never);
    plane.state.providers.set("prov-1", {
      id: "prov-1",
      usageRates: { currency: "USD", inputTokenMicros: "2", outputTokenMicros: "3" },
    } as never);

    expect(
      ingestUsage(plane.state, {
        type: "session:usage",
        sessionId: "s1",
        attemptId: "a1",
        worktreeId: "w1",
        usage: {
          kind: "delta",
          sequence: 1,
          inputTokens: "4",
          outputTokens: "5",
          source: "cli",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toEqual({ ok: true });
    expect(usageAggregate(plane.state)).toMatchObject({
      inputTokens: "4",
      outputTokens: "5",
      costMicros: "23",
      currency: "USD",
      costMicrosByCurrency: { USD: "23" },
    });
    expect(await plane.getUsageAggregateDurable()).toMatchObject({ costMicros: "23" });
  });

  it("does not infer a cost when no configured counter rate applies", () => {
    const usage = {
      kind: "delta" as const,
      sequence: 1,
      totalTokens: "9",
      source: "cli" as const,
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(costFromRates(usage, { currency: "USD", inputTokenMicros: "2" })).toBeUndefined();
    expect(
      costFromRates(
        { ...usage, inputTokens: "2", cachedInputTokens: "3", reasoningTokens: "4" },
        { currency: "USD", inputTokenMicros: "2", cachedInputTokenMicros: "5" },
      ),
    ).toBe("19");
  });

  it("keeps a reported cost and currency instead of replacing them with configured rates", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.state.sessions.set("s1", {
      id: "s1",
      repositoryId: "r1",
      attemptId: "a1",
      worktreeId: "w1",
      resolvedRoute: { providerAccountId: "acct-1", worktreeId: "w1", attemptId: "a1" },
    } as never);
    plane.state.providerAccounts.set("acct-1", { id: "acct-1", providerId: "prov-1" } as never);
    plane.state.providers.set("prov-1", {
      id: "prov-1",
      usageRates: { currency: "USD", inputTokenMicros: "2" },
    } as never);

    expect(
      ingestUsage(plane.state, {
        type: "session:usage",
        sessionId: "s1",
        attemptId: "a1",
        worktreeId: "w1",
        usage: {
          kind: "delta",
          sequence: 1,
          inputTokens: "9",
          costMicros: "4",
          currency: "EUR",
          source: "cli",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toEqual({ ok: true });
    expect(usageAggregate(plane.state)).toMatchObject({
      costMicros: "4",
      currency: "EUR",
      costMicrosByCurrency: { EUR: "4" },
    });
  });

  it("ignores stale reports and rejects malformed reports before attribution", () => {
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
    const message = {
      type: "session:usage" as const,
      sessionId: "s1",
      attemptId: "old",
      worktreeId: "w1",
      usage: {
        kind: "delta" as const,
        sequence: 1,
        inputTokens: "2",
        source: "cli" as const,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(ingestUsage(state, message)).toEqual({ ok: true });
    expect(ingestUsage(state, { ...message, attemptId: "a1", usage: {} })).toEqual({
      ok: false,
      error: "invalid usage report",
    });
  });

  it("allows the durable helper to use the in-memory path when storage is absent", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.state.sessions.set("s1", {
      id: "s1",
      repositoryId: "r1",
      attemptId: "a1",
      worktreeId: "w1",
    } as never);
    await expect(
      ingestUsageDurable(plane.state, {
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
      }),
    ).resolves.toEqual({ ok: true });
    expect(usageAggregate(plane.state, "s1").inputTokens).toBe("2");
  });

  it("rejects missing, invalid, stale, and conflicting durable reports", async () => {
    let session:
      | { id: string; repositoryId: string; attemptId: string; worktreeId: string }
      | undefined;
    let records: Array<
      typeof base & { kind: "cumulative"; sequence: number; inputTokens: string }
    > = [];
    const state = {
      storage: {
        getSession: async () => session,
        listUsageRecords: async () => records,
        putUsageRecord: async () => true,
      },
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsageDurable>[0];
    const report = {
      type: "session:usage" as const,
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta" as const,
        sequence: 1,
        inputTokens: "2",
        source: "cli" as const,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const fence = { hostId: "host-1", connectionId: "connection-1" };
    await expect(ingestUsageDurable(state, report, fence)).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
    session = { id: "s1", repositoryId: "r1", attemptId: "a1", worktreeId: "w1" };
    await expect(ingestUsageDurable(state, { ...report, usage: {} }, fence)).resolves.toEqual({
      ok: false,
      error: "invalid usage report",
    });
    await expect(
      ingestUsageDurable(state, { ...report, attemptId: "old" }, fence),
    ).resolves.toEqual({
      ok: true,
    });
    records = [{ ...base, kind: "cumulative", sequence: 1, inputTokens: "2" }];
    await expect(ingestUsageDurable(state, report, fence)).resolves.toEqual({
      ok: false,
      error: "usage report kind conflicts with this attempt",
    });
  });

  it("reads durable usage through the facade and caches it for subsequent aggregate reads", async () => {
    const plane = new ControlPlane();
    plane.state.storage = {
      listUsageRecords: async () => [{ ...base, kind: "delta", sequence: 1, inputTokens: "3" }],
    } as never;
    await expect(plane.getUsageDurable("s1")).resolves.toMatchObject([{ inputTokens: "3" }]);
    await expect(plane.getUsageAggregateDurable("s1")).resolves.toMatchObject({
      inputTokens: "3",
      reportCount: 1,
    });
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

  it("writes one fenced durable report with provider-derived attribution and rates", async () => {
    const session = {
      id: "s1",
      repositoryId: "r1",
      attemptId: "a1",
      worktreeId: "w1",
      resolvedRoute: { providerAccountId: "acct-1", commandId: "cmd-1" },
    };
    const writes: unknown[] = [];
    const state = {
      storage: {
        getSession: async () => session,
        getProviderAccount: async () => ({ id: "acct-1", providerId: "prov-1" }),
        getProvider: async () => ({
          id: "prov-1",
          usageRates: { currency: "USD", inputTokenMicros: "2" },
        }),
        listUsageRecords: async () => [],
        putUsageRecord: async (record: unknown) => {
          writes.push(record);
          return true;
        },
      },
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsageDurable>[0];
    const report = {
      type: "session:usage" as const,
      sessionId: "s1",
      attemptId: "a1",
      worktreeId: "w1",
      usage: {
        kind: "delta" as const,
        sequence: 1,
        inputTokens: "3",
        source: "cli" as const,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    await expect(
      ingestUsageDurable(state, report, { hostId: "host-1", connectionId: "connection-1" }),
    ).resolves.toEqual({ ok: true });
    expect(writes).toMatchObject([
      {
        providerId: "prov-1",
        providerAccountId: "acct-1",
        commandId: "cmd-1",
        costMicros: "6",
        currency: "USD",
      },
    ]);
    expect(state.usageRecords.size).toBe(1);
  });

  it("treats a concurrent same-kind durable write as an idempotent duplicate", async () => {
    const session = { id: "s1", repositoryId: "r1", attemptId: "a1", worktreeId: "w1" };
    const duplicate = {
      ...base,
      kind: "delta" as const,
      sequence: 1,
      inputTokens: "2",
    };
    const state = {
      storage: {
        getSession: async () => session,
        listUsageRecords: async () => [duplicate],
        putUsageRecord: async () => false,
      },
      sessions: new Map(),
      usageRecords: new Map(),
      providers: new Map(),
      providerAccounts: new Map(),
      now: () => "2026-01-01T00:00:00.000Z",
    } as unknown as Parameters<typeof ingestUsageDurable>[0];
    await expect(
      ingestUsageDurable(
        state,
        {
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
        },
        { hostId: "host-1", connectionId: "connection-1" },
      ),
    ).resolves.toEqual({ ok: true });
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

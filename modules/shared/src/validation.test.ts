import { describe, expect, it } from "vitest";

import {
  formatLogSortKey,
  isOnConflict,
  isSessionErrorCode,
  isSessionStatus,
  isTerminalSessionStatus,
  validateCreateSessionInput,
} from "./validation.ts";

describe("isSessionStatus", () => {
  it("accepts known statuses", () => {
    expect(isSessionStatus("queued")).toBe(true);
    expect(isSessionStatus("running")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isSessionStatus("pending")).toBe(false);
    expect(isSessionStatus(1)).toBe(false);
  });
});

describe("isTerminalSessionStatus", () => {
  it("accepts terminal statuses only", () => {
    expect(isTerminalSessionStatus("completed")).toBe(true);
    expect(isTerminalSessionStatus("failed")).toBe(true);
    expect(isTerminalSessionStatus("queued")).toBe(false);
    expect(isTerminalSessionStatus(null)).toBe(false);
  });
});

describe("isSessionErrorCode", () => {
  it("accepts known codes", () => {
    expect(isSessionErrorCode("usage_limit")).toBe(true);
    expect(isSessionErrorCode("resume_failed")).toBe(true);
  });

  it("rejects unknown codes", () => {
    expect(isSessionErrorCode("boom")).toBe(false);
  });
});

describe("isOnConflict", () => {
  it("accepts queue, replace, reject", () => {
    expect(isOnConflict("queue")).toBe(true);
    expect(isOnConflict("replace")).toBe(true);
    expect(isOnConflict("reject")).toBe(true);
    expect(isOnConflict("skip")).toBe(false);
  });
});

describe("validateCreateSessionInput", () => {
  const base = {
    repositoryId: "repo-1",
    prompt: "fix it",
    commandId: "cmd-1",
    timeout: 1800,
  };

  it("accepts a minimal valid payload", () => {
    const result = validateCreateSessionInput(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(0);
      expect(result.value.requiredLabels).toEqual([]);
      expect(result.value.onConflict).toBe("queue");
      expect(result.value.ref).toBeUndefined();
    }
  });

  it("accepts optional fields", () => {
    const result = validateCreateSessionInput({
      ...base,
      priority: 10,
      requiredLabels: ["codex"],
      onConflict: "replace",
      ref: "feature/x",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(10);
      expect(result.value.requiredLabels).toEqual(["codex"]);
      expect(result.value.onConflict).toBe("replace");
      expect(result.value.ref).toBe("feature/x");
    }
  });

  it("rejects missing repositoryId", () => {
    const result = validateCreateSessionInput({ ...base, repositoryId: "" });
    expect(result).toEqual({ ok: false, error: "repositoryId is required" });
  });

  it("rejects missing prompt", () => {
    const result = validateCreateSessionInput({ ...base, prompt: "" });
    expect(result).toEqual({ ok: false, error: "prompt is required" });
  });

  it("rejects when neither providerAccountId nor commandId is set", () => {
    const { commandId: _commandId, ...withoutTarget } = base;
    const result = validateCreateSessionInput(withoutTarget);
    expect(result).toEqual({
      ok: false,
      error: "exactly one of providerAccountId or commandId is required",
    });
  });

  it("rejects when both providerAccountId and commandId are set", () => {
    const result = validateCreateSessionInput({ ...base, providerAccountId: "acct-1" });
    expect(result).toEqual({
      ok: false,
      error: "exactly one of providerAccountId or commandId is required",
    });
  });

  it("rejects an empty commandId", () => {
    const result = validateCreateSessionInput({ ...base, commandId: "" });
    expect(result).toEqual({ ok: false, error: "commandId must be a non-empty string" });
  });

  it("rejects an empty providerAccountId", () => {
    const { commandId: _commandId, ...withoutCommand } = base;
    const result = validateCreateSessionInput({ ...withoutCommand, providerAccountId: "" });
    expect(result).toEqual({ ok: false, error: "providerAccountId must be a non-empty string" });
  });

  it("accepts a providerAccountId target", () => {
    const { commandId: _commandId, ...withoutCommand } = base;
    const result = validateCreateSessionInput({ ...withoutCommand, providerAccountId: "acct-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.providerAccountId).toBe("acct-1");
      expect(result.value.commandId).toBeUndefined();
    }
  });

  it("rejects invalid timeout", () => {
    expect(validateCreateSessionInput({ ...base, timeout: 0 }).ok).toBe(false);
    expect(validateCreateSessionInput({ ...base, timeout: -1 }).ok).toBe(false);
    expect(validateCreateSessionInput({ ...base, timeout: "x" as unknown as number }).ok).toBe(
      false,
    );
  });

  it("rejects invalid priority", () => {
    const result = validateCreateSessionInput({
      ...base,
      priority: "high" as unknown as number,
    });
    expect(result).toEqual({ ok: false, error: "priority must be a number" });
  });

  it("rejects invalid requiredLabels", () => {
    const result = validateCreateSessionInput({
      ...base,
      requiredLabels: [1] as unknown as string[],
    });
    expect(result).toEqual({
      ok: false,
      error: "requiredLabels must be an array of strings",
    });
  });

  it("rejects invalid onConflict", () => {
    const result = validateCreateSessionInput({
      ...base,
      onConflict: "skip" as unknown as "queue",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty ref when set", () => {
    const result = validateCreateSessionInput({ ...base, ref: "" });
    expect(result).toEqual({
      ok: false,
      error: "ref must be a non-empty string when set",
    });
  });

  it("accepts concurrencyKey and metadata", () => {
    const result = validateCreateSessionInput({
      ...base,
      concurrencyKey: "pr-12",
      metadata: { pr: 12 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.concurrencyKey).toBe("pr-12");
      expect(result.value.metadata).toEqual({ pr: 12 });
    }
  });

  it("rejects bad concurrencyKey and metadata", () => {
    expect(validateCreateSessionInput({ ...base, concurrencyKey: "" }).ok).toBe(false);
    expect(validateCreateSessionInput({ ...base, metadata: [] }).ok).toBe(false);
  });
});

describe("formatLogSortKey", () => {
  it("zero-pads seq for lexicographic order", () => {
    expect(formatLogSortKey("2026-08-01T12:00:00.000Z", 3)).toBe(
      "2026-08-01T12:00:00.000Z#0000000003",
    );
    expect(
      formatLogSortKey("2026-08-01T12:00:00.000Z", 12) <
        formatLogSortKey("2026-08-01T12:00:00.000Z", 100),
    ).toBe(true);
  });

  it("rejects bad inputs", () => {
    expect(() => formatLogSortKey("", 0)).toThrow("timestampIso is required");
    expect(() => formatLogSortKey("t", -1)).toThrow("seq must be a non-negative integer");
    expect(() => formatLogSortKey("t", 1.5)).toThrow("seq must be a non-negative integer");
  });
});

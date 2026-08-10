/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  isActiveSessionStatus,
  formatLogSortKey,
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

describe("isActiveSessionStatus", () => {
  it("accepts active statuses only", () => {
    expect(isActiveSessionStatus("queued")).toBe(true);
    expect(isActiveSessionStatus("running")).toBe(true);
    expect(isActiveSessionStatus("completed")).toBe(false);
    expect(isActiveSessionStatus(null)).toBe(false);
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

describe("validateCreateSessionInput", () => {
  const base = {
    repositoryId: "repo-1",
    prompt: "fix it",
    target: { commandId: "cmd-1" },
    timeout: 1800,
  };

  it("accepts a minimal valid payload", () => {
    const result = validateCreateSessionInput(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(0);
      expect(result.value.requiredLabels).toEqual([]);
      expect(result.value.queueTtlSeconds).toBe(691200);
      expect(result.value.ref).toBeUndefined();
    }
  });

  it("accepts optional fields", () => {
    const result = validateCreateSessionInput({
      ...base,
      priority: 10,
      requiredLabels: ["codex"],
      concurrencyId: "pr-12",
      ref: "feature/x",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.priority).toBe(10);
      expect(result.value.requiredLabels).toEqual(["codex"]);
      expect(result.value.concurrencyId).toBe("pr-12");
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

  it("requires one tagged target", () => {
    const { target: _target, ...withoutTarget } = base;
    const result = validateCreateSessionInput(withoutTarget);
    expect(result).toEqual({
      ok: false,
      error: "target must be an object with exactly one of providerId or commandId",
    });
  });

  it("rejects a target with both provider and command", () => {
    const result = validateCreateSessionInput({
      ...base,
      target: { providerId: "p", commandId: "c" },
    });
    expect(result).toEqual({
      ok: false,
      error: "target must contain exactly one of providerId or commandId",
    });
  });

  it("rejects an empty commandId", () => {
    const result = validateCreateSessionInput({ ...base, target: { commandId: "" } });
    expect(result).toEqual({ ok: false, error: "target.commandId must be a non-empty string" });
  });

  it("rejects an empty providerId", () => {
    const result = validateCreateSessionInput({ ...base, target: { providerId: "" } });
    expect(result).toEqual({ ok: false, error: "target.providerId must be a non-empty string" });
  });

  it("accepts provider targets and ordered fallbacks", () => {
    const result = validateCreateSessionInput({
      ...base,
      target: { providerId: "prov-1" },
      fallbacks: [{ commandId: "cmd-1" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.target).toEqual({ providerId: "prov-1" });
      expect(result.value.fallbacks).toEqual([{ commandId: "cmd-1" }]);
    }
  });

  it("allows equal provider and command IDs but rejects duplicates of the same target kind", () => {
    expect(
      validateCreateSessionInput({
        ...base,
        target: { providerId: "same" },
        fallbacks: [{ commandId: "same" }],
      }).ok,
    ).toBe(true);
    expect(validateCreateSessionInput({ ...base, fallbacks: [{ commandId: "cmd-1" }] })).toEqual({
      ok: false,
      error: "target and fallbacks must not contain duplicates",
    });
  });

  it("rejects an invalid fallback before checking duplicate target keys", () => {
    expect(
      validateCreateSessionInput({
        ...base,
        fallbacks: [{ commandId: "" }],
      }),
    ).toEqual({ ok: false, error: "fallbacks[0].commandId must be a non-empty string" });
  });

  it("validates queue TTL overrides", () => {
    expect(validateCreateSessionInput({ ...base, queueTtlSeconds: 3 }).ok).toBe(true);
    expect(validateCreateSessionInput({ ...base, queueTtlSeconds: 0 }).ok).toBe(false);
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

  it("rejects empty ref when set", () => {
    const result = validateCreateSessionInput({ ...base, ref: "" });
    expect(result).toEqual({
      ok: false,
      error: "ref must be a non-empty string when set",
    });
  });

  it("accepts concurrencyId and metadata", () => {
    const result = validateCreateSessionInput({
      ...base,
      concurrencyId: "pr-12",
      metadata: { pr: 12 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.concurrencyId).toBe("pr-12");
      expect(result.value.metadata).toEqual({ pr: 12 });
    }
  });

  it("rejects bad concurrencyId and metadata", () => {
    expect(validateCreateSessionInput({ ...base, concurrencyId: "" }).ok).toBe(false);
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

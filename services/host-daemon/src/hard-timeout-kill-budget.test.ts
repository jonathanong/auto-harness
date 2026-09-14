import { describe, expect, it } from "vitest";

import { DEFAULT_TERMINATION_GRACE_MS, hardTimeoutKillBudget } from "./hard-timeout-kill-budget.ts";

describe("hardTimeoutKillBudget", () => {
  it("SIGTERMs with the default grace so SIGKILL lands on a long POSIX deadline", () => {
    expect(hardTimeoutKillBudget(60_000, "linux")).toEqual({
      timeoutMs: 60_000 - DEFAULT_TERMINATION_GRACE_MS,
      terminationGraceMs: DEFAULT_TERMINATION_GRACE_MS,
    });
    expect(hardTimeoutKillBudget(10_000, "darwin")).toEqual({
      timeoutMs: 5_000,
      terminationGraceMs: 5_000,
    });
  });

  it("SIGKILLs at expiry when a recovered POSIX handoff has less than 5s remaining", () => {
    expect(hardTimeoutKillBudget(3_000, "linux")).toEqual({
      timeoutMs: 3_000,
      terminationGraceMs: 0,
    });
    expect(hardTimeoutKillBudget(DEFAULT_TERMINATION_GRACE_MS, "linux")).toEqual({
      timeoutMs: DEFAULT_TERMINATION_GRACE_MS,
      terminationGraceMs: 0,
    });
  });

  it("uses one forceful Windows kill at the deadline and omits a delayed second kill", () => {
    expect(hardTimeoutKillBudget(10_000, "win32")).toEqual({ timeoutMs: 10_000 });
    expect(hardTimeoutKillBudget(3_000, "win32")).toEqual({ timeoutMs: 3_000 });
    expect(hardTimeoutKillBudget(3_000, "win32")).not.toHaveProperty("terminationGraceMs");
  });

  it("clamps a non-positive remaining budget to an immediate timeout", () => {
    expect(hardTimeoutKillBudget(0, "linux")).toEqual({
      timeoutMs: 0,
      terminationGraceMs: 0,
    });
    expect(hardTimeoutKillBudget(-5, "linux")).toEqual({
      timeoutMs: 0,
      terminationGraceMs: 0,
    });
    expect(hardTimeoutKillBudget(-5, "win32")).toEqual({ timeoutMs: 0 });
  });
});

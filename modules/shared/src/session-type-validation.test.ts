import { describe, expect, it } from "vitest";

import { isSessionSource, isSessionType, validateCreateSessionInput } from "./validation.ts";

const base = { repositoryId: "repo", prompt: "work", commandId: "command", timeout: 30 };

describe("session type validation", () => {
  it("recognizes only supported type/source values", () => {
    expect(isSessionType("prompt")).toBe(true);
    expect(isSessionType("scheduled")).toBe(true);
    expect(isSessionType("other")).toBe(false);
    expect(isSessionSource("schedule")).toBe(true);
    expect(isSessionSource("other")).toBe(false);
  });

  it("defaults a prompt session and validates explicit values", () => {
    expect(validateCreateSessionInput(base)).toMatchObject({
      ok: true,
      value: { type: "prompt", source: "api" },
    });
    expect(
      validateCreateSessionInput({ ...base, type: "scheduled", source: "schedule" }),
    ).toMatchObject({ ok: true, value: { type: "scheduled", source: "schedule" } });
    expect(validateCreateSessionInput({ ...base, type: "other" })).toEqual({
      ok: false,
      error: "type must be prompt or scheduled",
    });
    expect(validateCreateSessionInput({ ...base, source: "other" })).toEqual({
      ok: false,
      error: "source must be api, ui, webhook, or schedule",
    });
  });

  it("keeps generic prompt refs flexible", () => {
    expect(validateCreateSessionInput({ ...base, ref: "0123456789abcdef" })).toMatchObject({
      ok: true,
      value: { ref: "0123456789abcdef", type: "prompt" },
    });
    expect(
      validateCreateSessionInput({
        ...base,
        type: "scheduled",
        source: "schedule",
        ref: "0123456789abcdef",
      }),
    ).toEqual({ ok: false, error: "scheduled ref must be a valid branch name" });
    expect(
      validateCreateSessionInput({ ...base, type: "scheduled", source: "schedule", ref: "main" }),
    ).toMatchObject({ ok: true, value: { ref: "main", type: "scheduled" } });
  });
});

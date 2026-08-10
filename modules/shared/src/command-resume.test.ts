import { describe, expect, it } from "vitest";

import {
  isValidCliResumeRef,
  materializeResumeArgv,
  validateCommandArgv,
  validateCommandResumeSpec,
} from "./command-resume.ts";

describe("command native resume schema", () => {
  it("accepts argv templates and expands only known placeholders", () => {
    const result = validateCommandResumeSpec({
      resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "session id: " },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"],
        resumeRefCapture: { stream: "stdout", linePrefix: "session id: " },
      },
    });
    if (result.ok) {
      expect(materializeResumeArgv(result.value.resumeArgvTemplate!, "abc", "continue")).toEqual([
        "codex",
        "resume",
        "abc",
        "continue",
      ]);
      expect(
        materializeResumeArgv(
          result.value.resumeArgvTemplate!,
          "opaque$&{prompt}",
          "continue $1 {cliResumeRef}",
        ),
      ).toEqual(["codex", "resume", "opaque$&{prompt}", "continue $1 {cliResumeRef}"]);
    }
  });

  it("rejects unknown placeholders, controls, and oversized values", () => {
    expect(validateCommandResumeSpec({ resumeArgvTemplate: ["x", "{shell}"] }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: ["x", "{prompt}"] }).ok).toBe(false);
    expect(
      validateCommandResumeSpec({
        resumeArgvTemplate: ["x", "{cliResumeRef}", "{{prompt}}"],
      }).ok,
    ).toBe(false);
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "stdout", linePrefix: "x\n" } }).ok,
    ).toBe(false);
    expect(validateCommandArgv(["x\u0000"]).ok).toBe(false);
    expect(
      validateCommandResumeSpec({
        resumeRefCapture: { stream: "stdout", linePrefix: "x".repeat(129) },
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed and oversized argv inputs", () => {
    expect(validateCommandArgv(undefined)).toEqual({
      ok: false,
      error: "argv must contain 1-64 entries",
    });
    expect(validateCommandArgv([]).ok).toBe(false);
    expect(validateCommandArgv(["x".repeat(4097)]).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: [] }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: [""] }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: ["x{prompt"] })).toEqual({
      ok: false,
      error: "resumeArgvTemplate contains malformed placeholders",
    });
    expect(validateCommandResumeSpec({ resumeRefCapture: ["stdout", "id: "] })).toEqual({
      ok: false,
      error: "resumeRefCapture must be an object",
    });
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "other", linePrefix: "id: " } }),
    ).toEqual({
      ok: false,
      error: "resumeRefCapture.stream must be stdout, stderr, or either",
    });
    expect(validateCommandResumeSpec({ resumeRefCapture: { stream: "stdout" } })).toEqual({
      ok: false,
      error: "resumeRefCapture.linePrefix must be a non-empty string",
    });
  });

  it("validates resume references at the byte and control boundaries", () => {
    expect(
      validateCommandResumeSpec({ resumeArgvTemplate: ["x", "{cliResumeRef}", "{cliResumeRef}"] })
        .ok,
    ).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: ["x"] }).ok).toBe(false);
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "stderr", linePrefix: "ok: " } }),
    ).toEqual({
      ok: true,
      value: { resumeRefCapture: { stream: "stderr", linePrefix: "ok: " } },
    });
  });

  it("rejects every invalid argv and template shape", () => {
    expect(validateCommandArgv(null).ok).toBe(false);
    expect(validateCommandArgv([]).ok).toBe(false);
    expect(validateCommandArgv(Array.from({ length: 65 }, () => "x")).ok).toBe(false);
    expect(validateCommandArgv([1]).ok).toBe(false);
    expect(validateCommandArgv([""]).ok).toBe(false);
    expect(validateCommandArgv(["x".repeat(4_097)]).ok).toBe(false);

    expect(validateCommandResumeSpec({ resumeArgvTemplate: "x" }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: [] }).ok).toBe(false);
    expect(
      validateCommandResumeSpec({
        resumeArgvTemplate: Array.from({ length: 65 }, () => "{cliResumeRef}"),
      }).ok,
    ).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: [1] }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: [""] }).ok).toBe(false);
    expect(
      validateCommandResumeSpec({
        resumeArgvTemplate: ["{cliResumeRef}", "x".repeat(4_097)],
      }).ok,
    ).toBe(false);
    expect(validateCommandResumeSpec({ resumeArgvTemplate: ["x", "{cliResumeRef", "}"] }).ok).toBe(
      false,
    );
    expect(
      validateCommandResumeSpec({
        resumeArgvTemplate: ["x", "{cliResumeRef}", "{cliResumeRef}"],
      }).ok,
    ).toBe(false);
  });

  it("rejects malformed capture policies and unsafe resume references", () => {
    expect(validateCommandResumeSpec({ resumeRefCapture: "id=" }).ok).toBe(false);
    expect(validateCommandResumeSpec({ resumeRefCapture: [] }).ok).toBe(false);
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "both", linePrefix: "id=" } }).ok,
    ).toBe(false);
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "stdout", linePrefix: 1 } }).ok,
    ).toBe(false);
    expect(
      validateCommandResumeSpec({ resumeRefCapture: { stream: "stdout", linePrefix: "" } }).ok,
    ).toBe(false);
    expect(isValidCliResumeRef("native-ref")).toBe(true);
    expect(isValidCliResumeRef(1)).toBe(false);
    expect(isValidCliResumeRef("")).toBe(false);
    expect(isValidCliResumeRef("bad\nref")).toBe(false);
    expect(isValidCliResumeRef("💾".repeat(129))).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_FILES,
  MAX_SESSION_ARTIFACT_SOURCE_BYTES,
  MAX_SESSION_OUTPUT_BYTES,
} from "@auto-harness/shared";

import { parsePrepareSessionOutputs } from "./session-outputs-validate.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function request(overrides: Record<string, unknown> = {}) {
  const jsonText = "null";
  return {
    attemptId: "attempt-1",
    capturedAt: "2026-10-08T12:00:00.000Z",
    output: { state: "ready", jsonText, sha256: sha(jsonText) },
    artifacts: { state: "none" },
    ...overrides,
  };
}

function readyOutput(jsonText: string) {
  return { state: "ready", jsonText, sha256: sha(jsonText) };
}

function pendingArtifacts(overrides: Record<string, unknown> = {}) {
  return {
    state: "pending",
    compressedBytes: 1,
    sourceBytes: 0,
    fileCount: 1,
    sha256: "a".repeat(64),
    ...overrides,
  };
}

describe("parsePrepareSessionOutputs", () => {
  it.each(["null", "false", "0", "1e400", '["deep",{"value":[1,2]}]'])(
    "accepts any valid JSON text and preserves its exact bytes (%s)",
    (jsonText) => {
      const parsed = parsePrepareSessionOutputs(request({ output: readyOutput(jsonText) }));
      expect(parsed?.output).toEqual(readyOutput(jsonText));
    },
  );

  it("accepts maximum-sized output and artifacts metadata", () => {
    const jsonText = `"${"x".repeat(MAX_SESSION_OUTPUT_BYTES - 2)}"`;
    expect(
      parsePrepareSessionOutputs(
        request({
          output: readyOutput(jsonText),
          artifacts: pendingArtifacts({
            compressedBytes: MAX_SESSION_ARTIFACT_BYTES,
            sourceBytes: MAX_SESSION_ARTIFACT_SOURCE_BYTES,
            fileCount: MAX_SESSION_ARTIFACT_FILES,
          }),
        }),
      ),
    ).not.toBeNull();
  });

  it.each([
    null,
    [],
    { ...request(), extra: true },
    { ...request(), attemptId: "" },
    { ...request(), attemptId: "x".repeat(257) },
    { ...request(), capturedAt: "not a date" },
  ])("rejects malformed top-level request %#", (value) => {
    expect(parsePrepareSessionOutputs(value)).toBeNull();
  });

  it.each([
    { state: "ready", jsonText: "{", sha256: sha("{") },
    { state: "ready", jsonText: 1, sha256: sha("null") },
    { state: "ready", jsonText: "null", sha256: 1 },
    { state: "ready", jsonText: "null", sha256: "A".repeat(64) },
    { state: "ready", jsonText: "true", sha256: "0".repeat(64) },
    {
      state: "ready",
      jsonText: `"${"x".repeat(MAX_SESSION_OUTPUT_BYTES - 1)}"`,
      sha256: sha(`"${"x".repeat(MAX_SESSION_OUTPUT_BYTES - 1)}"`),
    },
    { state: "ready", jsonText: "null", sha256: sha("null"), other: true },
    { state: "error", error: { code: "", message: "message" } },
    { state: "error", error: null },
    { state: "error", error: { code: 1, message: "message" } },
    { state: "error", error: { code: "x".repeat(257), message: "message" } },
    { state: "error", error: { code: "CODE", message: 1 } },
    { state: "error", error: { code: "CODE", message: "x".repeat(257) } },
    { state: "error", error: { code: "CODE", message: "message", extra: true } },
    { state: "none", extra: true },
    { state: "pending" },
  ])("rejects malformed output submission %#", (output) => {
    expect(parsePrepareSessionOutputs(request({ output }))).toBeNull();
  });

  it.each([
    { state: "pending", compressedBytes: 0 },
    { state: "pending", compressedBytes: MAX_SESSION_ARTIFACT_BYTES + 1 },
    { state: "pending", sourceBytes: -1 },
    { state: "pending", sourceBytes: MAX_SESSION_ARTIFACT_SOURCE_BYTES + 1 },
    { state: "pending", fileCount: 0 },
    { state: "pending", fileCount: MAX_SESSION_ARTIFACT_FILES + 1 },
    { state: "pending", compressedBytes: 1.5 },
    { state: "pending", sourceBytes: Number.MAX_SAFE_INTEGER + 1 },
    { state: "pending", sha256: 1 },
    { state: "pending", sha256: "A".repeat(64) },
    { state: "pending", extra: true },
    { state: "error", error: { code: "CODE", message: "x".repeat(257) } },
    { state: "error", error: { code: "CODE", message: "message", extra: true } },
    { state: "none", extra: true },
    { state: "ready" },
  ])("rejects malformed artifacts submission %#", (artifacts) => {
    expect(
      parsePrepareSessionOutputs(request({ artifacts: { ...pendingArtifacts(), ...artifacts } })),
    ).toBeNull();
  });

  it("requires both output and artifacts to be objects", () => {
    expect(parsePrepareSessionOutputs(request({ output: null }))).toBeNull();
    expect(parsePrepareSessionOutputs(request({ artifacts: [] }))).toBeNull();
    expect(parsePrepareSessionOutputs(request({ output: "" }))).toBeNull();
    expect(parsePrepareSessionOutputs(request({ artifacts: 0 }))).toBeNull();
  });
});

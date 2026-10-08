import { createHash } from "node:crypto";
import {
  MAX_SESSION_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_FILES,
  MAX_SESSION_ARTIFACT_SOURCE_BYTES,
  MAX_SESSION_OUTPUT_BYTES,
  type PrepareSessionOutputsRequest,
} from "@auto-harness/shared";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_ERROR_FIELD = 256;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validError(value: unknown): value is { code: string; message: string } {
  const error = object(value);
  return (
    !!error &&
    typeof error.code === "string" &&
    error.code.length > 0 &&
    error.code.length <= MAX_ERROR_FIELD &&
    typeof error.message === "string" &&
    error.message.length <= MAX_ERROR_FIELD &&
    Object.keys(error).length === 2
  );
}

function boundedInt(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Validate the exact durable submission before any row or upload URL is created. */
export function parsePrepareSessionOutputs(value: unknown): PrepareSessionOutputsRequest | null {
  const request = object(value);
  if (
    !request ||
    Object.keys(request).some(
      (key) => !["attemptId", "capturedAt", "output", "artifacts"].includes(key),
    )
  )
    return null;
  if (
    typeof request.attemptId !== "string" ||
    request.attemptId.length < 1 ||
    request.attemptId.length > 256
  )
    return null;
  if (typeof request.capturedAt !== "string" || !Number.isFinite(Date.parse(request.capturedAt)))
    return null;
  const output = object(request.output);
  const artifacts = object(request.artifacts);
  if (!output || !artifacts) return null;
  if (output.state === "ready") {
    if (
      typeof output.jsonText !== "string" ||
      Buffer.byteLength(output.jsonText, "utf8") > MAX_SESSION_OUTPUT_BYTES ||
      typeof output.sha256 !== "string" ||
      !HEX_SHA256.test(output.sha256) ||
      createHash("sha256").update(output.jsonText).digest("hex") !== output.sha256
    )
      return null;
    try {
      JSON.parse(output.jsonText);
    } catch {
      return null;
    }
    if (Object.keys(output).some((key) => !["state", "jsonText", "sha256"].includes(key)))
      return null;
  } else if (output.state === "error") {
    if (
      !validError(output.error) ||
      Object.keys(output).some((key) => !["state", "error"].includes(key))
    )
      return null;
  } else if (output.state !== "none" || Object.keys(output).length !== 1) return null;

  if (artifacts.state === "pending") {
    if (
      !boundedInt(artifacts.compressedBytes, 1, MAX_SESSION_ARTIFACT_BYTES) ||
      !boundedInt(artifacts.sourceBytes, 0, MAX_SESSION_ARTIFACT_SOURCE_BYTES) ||
      !boundedInt(artifacts.fileCount, 1, MAX_SESSION_ARTIFACT_FILES) ||
      typeof artifacts.sha256 !== "string" ||
      !HEX_SHA256.test(artifacts.sha256) ||
      Object.keys(artifacts).some(
        (key) => !["state", "compressedBytes", "sourceBytes", "fileCount", "sha256"].includes(key),
      )
    )
      return null;
  } else if (artifacts.state === "error") {
    if (
      !validError(artifacts.error) ||
      Object.keys(artifacts).some((key) => !["state", "error"].includes(key))
    )
      return null;
  } else if (artifacts.state !== "none" || Object.keys(artifacts).length !== 1) return null;
  return request as PrepareSessionOutputsRequest;
}

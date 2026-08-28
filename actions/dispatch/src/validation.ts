import { AutoHarnessError, AutoHarnessRequestTimeoutError } from "auto-harness-client";

import { setOutput } from "./io.ts";

const drainStatuses = new Set(["draining", "succeeded", "failed", "released"] as const);

type DrainStatus = "draining" | "succeeded" | "failed" | "released";

export type ValidatedDrain = {
  operationId: string;
  repositoryId: string;
  status: DrainStatus;
  statusUrl: string;
  queuedCount: number;
  runningCount: number;
  cancelledCount: number;
  failureCode?: string;
};

type ValidatedSession = { id: string; url: string; created: boolean };

function record(value: unknown, malformedMessage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(malformedMessage);
  }
  return value as Record<string, unknown>;
}

function absoluteApiUrl(baseUrl: string, statusUrl: unknown): string {
  if (typeof statusUrl !== "string" || !statusUrl.startsWith("/api/v1/")) {
    throw new Error("Auto Harness returned a malformed principal session drain statusUrl");
  }
  return new URL(statusUrl, `${baseUrl}/`).toString();
}

export function validateDrain(
  value: unknown,
  baseUrl: string,
  repositoryId: string,
  expectedOperationId?: string,
): ValidatedDrain {
  const result = record(
    value,
    "Auto Harness returned a malformed principal session drain response",
  );
  if (
    typeof result.operationId !== "string" ||
    !result.operationId ||
    /[\r\n]/.test(result.operationId)
  ) {
    throw new Error("Auto Harness returned a principal session drain without an operationId");
  }
  if (expectedOperationId !== undefined && result.operationId !== expectedOperationId) {
    throw new Error("Auto Harness returned a different principal session drain operation");
  }
  if (result.repositoryId !== repositoryId) {
    throw new Error("Auto Harness returned a principal session drain for a different repository");
  }
  if (!drainStatuses.has(result.status as DrainStatus)) {
    throw new Error("Auto Harness returned an unknown principal session drain status");
  }
  for (const name of ["queuedCount", "runningCount", "cancelledCount"] as const) {
    if (!Number.isSafeInteger(result[name]) || Number(result[name]) < 0) {
      throw new Error(`Auto Harness returned an invalid principal session drain ${name}`);
    }
  }
  if (
    result.failureCode !== undefined &&
    (typeof result.failureCode !== "string" || /[\r\n]/.test(result.failureCode))
  ) {
    throw new Error("Auto Harness returned an invalid principal session drain failureCode");
  }
  const statusUrl = absoluteApiUrl(baseUrl, result.statusUrl);
  const expectedPath = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`;
  if (new URL(statusUrl).pathname !== expectedPath) {
    throw new Error(
      "Auto Harness returned a principal session drain statusUrl for a different operation",
    );
  }
  return {
    operationId: result.operationId,
    repositoryId,
    status: result.status as DrainStatus,
    statusUrl,
    queuedCount: Number(result.queuedCount),
    runningCount: Number(result.runningCount),
    cancelledCount: Number(result.cancelledCount),
    ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode as string }),
  };
}

export function validateSession(value: unknown): ValidatedSession {
  const result = record(value, "Auto Harness returned a malformed session response");
  if (typeof result.id !== "string" || !result.id || /[\r\n]/.test(result.id)) {
    throw new Error("Auto Harness returned a session without a valid id");
  }
  if (typeof result.url !== "string" || !result.url || /[\r\n]/.test(result.url)) {
    throw new Error("Auto Harness returned a session without a valid url");
  }
  if (typeof result.created !== "boolean") {
    throw new Error("Auto Harness returned a session without a created result");
  }
  return { id: result.id, url: result.url, created: result.created };
}

export function setDrainOutputs(result: ValidatedDrain): void {
  setOutput("operation-id", result.operationId);
  setOutput("status-url", result.statusUrl);
  setOutput("drain-status", result.status);
  setOutput("drain-terminal", String(result.status !== "draining"));
  setOutput("queued-count", String(result.queuedCount));
  setOutput("running-count", String(result.runningCount));
  setOutput("cancelled-count", String(result.cancelledCount));
  setOutput("failure-code", result.failureCode ?? "");
}

export function actionErrorMessage(error: unknown, baseUrl: string, isDrain: boolean): string {
  if (error instanceof AutoHarnessRequestTimeoutError) {
    return isDrain
      ? "Timed out waiting for principal session drain"
      : "Timed out waiting for Auto Harness request";
  }
  if (error instanceof AutoHarnessError && error.statusUrl) {
    try {
      const operationId = error.operationId ?? "unknown";
      return `${error.message}; drain ${operationId}: ${absoluteApiUrl(baseUrl, error.statusUrl)}`;
    } catch {
      return error.message;
    }
  }
  if (error instanceof AutoHarnessError && error.code === "HTTP_ERROR") {
    return `Auto Harness returned ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

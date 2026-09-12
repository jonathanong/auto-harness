import { setOutput } from "./io.ts";

const sessionStatuses = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const terminalSessionStatuses = new Set(["completed", "failed", "cancelled", "timed_out"]);

type ValidatedSessionResult = {
  summary: string;
  summarySource: "agent" | "harness";
  summaryTruncated?: true;
  branch?: string;
  filesChanged?: string[];
  filesChangedTruncated?: true;
  pullRequestUrl?: string;
};

export type ValidatedSessionDetail = {
  id: string;
  url: string;
  status: string;
  result?: ValidatedSessionResult;
};

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateResult(value: unknown): ValidatedSessionResult {
  const result = record(value, "Auto Harness returned a malformed session result");
  if (!nonEmptyString(result.summary)) {
    throw new Error("Auto Harness returned a session result without a summary");
  }
  if (result.summarySource !== "agent" && result.summarySource !== "harness") {
    throw new Error("Auto Harness returned a session result without a valid summarySource");
  }
  if (result.summaryTruncated !== undefined && result.summaryTruncated !== true) {
    throw new Error("Auto Harness returned a session result with invalid summaryTruncated");
  }
  if (result.branch !== undefined && typeof result.branch !== "string") {
    throw new Error("Auto Harness returned a session result with an invalid branch");
  }
  if (
    result.filesChanged !== undefined &&
    (!Array.isArray(result.filesChanged) ||
      result.filesChanged.some((file) => typeof file !== "string"))
  ) {
    throw new Error("Auto Harness returned a session result with invalid filesChanged");
  }
  if (result.filesChangedTruncated !== undefined && result.filesChangedTruncated !== true) {
    throw new Error("Auto Harness returned a session result with invalid filesChangedTruncated");
  }
  if (result.pullRequestUrl !== undefined && typeof result.pullRequestUrl !== "string") {
    throw new Error("Auto Harness returned a session result with an invalid pullRequestUrl");
  }
  return {
    summary: result.summary,
    summarySource: result.summarySource,
    ...(result.summaryTruncated === undefined ? {} : { summaryTruncated: result.summaryTruncated }),
    ...(result.branch === undefined ? {} : { branch: result.branch }),
    ...(result.filesChanged === undefined ? {} : { filesChanged: result.filesChanged }),
    ...(result.filesChangedTruncated === undefined
      ? {}
      : { filesChangedTruncated: result.filesChangedTruncated }),
    ...(result.pullRequestUrl === undefined ? {} : { pullRequestUrl: result.pullRequestUrl }),
  };
}

/** Validates the GET /sessions/:id representation used by the one-shot get-result operation. */
export function validateSessionDetail(value: unknown): ValidatedSessionDetail {
  const result = record(value, "Auto Harness returned a malformed session response");
  if (!nonEmptyString(result.id) || /[\r\n]/.test(result.id)) {
    throw new Error("Auto Harness returned a session without a valid id");
  }
  if (!nonEmptyString(result.url) || /[\r\n]/.test(result.url)) {
    throw new Error("Auto Harness returned a session without a valid url");
  }
  const status = typeof result.status === "string" ? result.status : undefined;
  if (!status || !sessionStatuses.has(status)) {
    throw new Error("Auto Harness returned a session without a valid status");
  }
  return {
    id: result.id,
    url: result.url,
    status,
    ...(result.result === undefined ? {} : { result: validateResult(result.result) }),
  };
}

export function isTerminalSessionStatus(status: string): boolean {
  return terminalSessionStatuses.has(status);
}

export function setSessionResultOutputs(result: ValidatedSessionResult | undefined): void {
  setOutput("session-result", result === undefined ? "" : JSON.stringify(result));
  setOutput("result-summary", result?.summary ?? "");
  setOutput("result-summary-truncated", result?.summaryTruncated === true ? "true" : "");
  setOutput("result-summary-source", result?.summarySource ?? "");
  setOutput("result-branch", result?.branch ?? "");
  setOutput(
    "result-files-changed",
    result?.filesChanged === undefined ? "" : JSON.stringify(result.filesChanged),
  );
  setOutput(
    "result-files-changed-truncated",
    result?.filesChanged === undefined
      ? ""
      : result.filesChangedTruncated === true
        ? "true"
        : "false",
  );
  setOutput("result-pull-request-url", result?.pullRequestUrl ?? "");
}

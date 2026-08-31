import { appendFileSync } from "node:fs";

export function writeDrainOutputs(environment, drain) {
  if (!environment.GITHUB_OUTPUT) return;
  appendFileSync(
    environment.GITHUB_OUTPUT,
    [
      `operation-id=${drain.operationId}`,
      `status=${drain.status}`,
      `queued-count=${drain.queuedCount}`,
      `running-count=${drain.runningCount}`,
      `cancelled-count=${drain.cancelledCount}`,
      `failure-code=${drain.failureCode ?? ""}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

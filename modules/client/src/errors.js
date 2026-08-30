export class AutoHarnessError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "AutoHarnessError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.operationId = options.operationId;
    this.statusUrl = options.statusUrl;
  }
}

export class AutoHarnessRequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Auto Harness request timed out after ${timeoutMs}ms`);
    this.name = "AutoHarnessRequestTimeoutError";
    this.code = "REQUEST_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export class AutoHarnessDrainWaitTimeoutError extends Error {
  constructor(repositoryId, operationId, timeoutMs) {
    super(`Auto Harness session drain wait timed out after ${timeoutMs}ms`);
    this.name = "AutoHarnessDrainWaitTimeoutError";
    this.code = "DRAIN_WAIT_TIMEOUT";
    this.repositoryId = repositoryId;
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
}

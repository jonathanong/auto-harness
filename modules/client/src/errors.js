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

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

export class AutoHarnessClient {
  constructor(options) {
    if (!options?.baseUrl) throw new TypeError("baseUrl is required");
    const requestTimeoutMs =
      options.requestTimeoutMs === undefined ? 30_000 : options.requestTimeoutMs;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 300_000) {
      throw new TypeError(
        "requestTimeoutMs must be a finite positive number no greater than 300000",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (!this.fetch) throw new TypeError("fetch is required");
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async request(path, init = {}) {
    const headers = { accept: "application/json", ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const controller = new AbortController();
    const timeoutError = new AutoHarnessRequestTimeoutError(this.requestTimeoutMs);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, this.requestTimeoutMs);
    });
    const request = (async () => {
      const response = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const body =
        response.status === 204
          ? undefined
          : await response.json().catch((error) => {
              if (controller.signal.aborted) throw error;
              return undefined;
            });
      if (!response.ok) {
        const error = body?.error;
        throw new AutoHarnessError(
          error?.message ?? `Auto Harness request failed (${response.status})`,
          {
            status: response.status,
            code: error?.code ?? "HTTP_ERROR",
            retryAfter: response.headers.get("retry-after") ?? undefined,
            operationId: error?.operationId,
            statusUrl: error?.statusUrl,
          },
        );
      }
      return body;
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  createSession(input) {
    return this.request("/sessions", { method: "POST", body: JSON.stringify(input) });
  }

  getSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}`);
  }

  cancelSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** Resume a previously assigned session on its pinned host, native CLI resume where supported. */
  resumeSession(id, input) {
    return this.request(`/sessions/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  }

  listSessions(options = {}) {
    const query = new URLSearchParams();
    if (options.status !== undefined) query.set("status", options.status);
    if (options.repositoryId !== undefined) query.set("repositoryId", options.repositoryId);
    if (options.hostId !== undefined) query.set("hostId", options.hostId);
    if (options.source !== undefined) query.set("source", options.source);
    if (options.sort !== undefined) query.set("sort", options.sort);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    if (options.concurrencyId !== undefined) query.set("concurrencyId", options.concurrencyId);
    if (options.scheduleId !== undefined) query.set("scheduleId", options.scheduleId);
    const suffix = query.toString();
    return this.request(suffix ? `/sessions?${suffix}` : "/sessions");
  }

  /**
   * Atomically fence this authenticated principal's session admission for one repository and
   * begin cancelling its existing work. Reuse an idempotency key after an ambiguous retry.
   */
  startSessionDrain(repositoryId, options = {}) {
    return this.request(`/repositories/${encodeURIComponent(repositoryId)}/session-drains`, {
      method: "POST",
      ...(options.idempotencyKey === undefined
        ? {}
        : { headers: { "idempotency-key": options.idempotencyKey } }),
    });
  }

  /** Get bounded durable progress or terminal proof for one principal session drain. */
  getSessionDrain(repositoryId, operationId) {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(operationId)}`,
    );
  }

  /** Explicitly reopen admission after a succeeded or failed principal session drain. */
  releaseSessionDrain(repositoryId, operationId) {
    return this.request(
      `/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(operationId)}/release`,
      { method: "POST" },
    );
  }

  listRepositories(options = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const suffix = query.toString();
    return this.request(suffix ? `/repositories?${suffix}` : "/repositories");
  }

  pauseRepository(id) {
    return this.repositoryOperation(id, "pause");
  }

  drainRepository(id) {
    return this.repositoryOperation(id, "drain");
  }

  activateRepository(id) {
    return this.repositoryOperation(id, "activate");
  }

  repositoryOperation(id, operation) {
    return this.request(`/repositories/${encodeURIComponent(id)}/${operation}`, { method: "POST" });
  }
}

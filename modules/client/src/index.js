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

export class AutoHarnessClient {
  constructor(options) {
    if (!options?.baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
    this.apiKey = options.apiKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    if (!this.fetch) throw new TypeError("fetch is required");
  }

  async request(path, init = {}) {
    const headers = { accept: "application/json", ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
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
    const path = suffix ? `/repositories?${suffix}` : "/repositories";
    return this.request(path);
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

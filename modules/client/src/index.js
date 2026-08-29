import { AutoHarnessError, AutoHarnessRequestTimeoutError } from "./errors.js";
import { resolveRepositoryId } from "./resolve-repository.js";
import { resolveCreateSessionTargets } from "./resolve-target.js";

export { AutoHarnessError, AutoHarnessRequestTimeoutError };

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

  async createSession(input) {
    const body = await resolveCreateSessionTargets(this, input);
    return this.request("/sessions", { method: "POST", body: JSON.stringify(body) });
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
  async startSessionDrain(repositoryId, options = {}) {
    const id = await resolveRepositoryId(this, repositoryId);
    return this.request(`/repositories/${encodeURIComponent(id)}/session-drains`, {
      method: "POST",
      ...(options.idempotencyKey === undefined
        ? {}
        : { headers: { "idempotency-key": options.idempotencyKey } }),
    });
  }

  /** Get bounded durable progress or terminal proof for one principal session drain. */
  async getSessionDrain(repositoryId, operationId) {
    const id = await resolveRepositoryId(this, repositoryId);
    return this.request(
      `/repositories/${encodeURIComponent(id)}/session-drains/${encodeURIComponent(operationId)}`,
    );
  }

  /** Explicitly reopen admission after a succeeded or failed principal session drain. */
  async releaseSessionDrain(repositoryId, operationId) {
    const id = await resolveRepositoryId(this, repositoryId);
    return this.request(
      `/repositories/${encodeURIComponent(id)}/session-drains/${encodeURIComponent(operationId)}/release`,
      { method: "POST" },
    );
  }

  /**
   * Polls `getSessionDrain()` until it reports a terminal status, clamping each request's
   * deadline to the time remaining before `timeoutMs` so no single request can outlive the
   * overall wait. Resolves with the terminal `SessionDrain` for any status, including "failed"
   * and "released" — callers classify success themselves. Rejects with
   * `AutoHarnessRequestTimeoutError` when `timeoutMs` elapses first.
   */
  async waitForSessionDrain(repositoryId, operationId, options = {}) {
    const { pollIntervalMs, timeoutMs } = options;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError("pollIntervalMs must be a finite positive number");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("timeoutMs must be a finite positive number");
    }
    const id = await resolveRepositoryId(this, repositoryId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new AutoHarnessRequestTimeoutError(timeoutMs);
      const pollClient = new AutoHarnessClient({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        fetch: this.fetch,
        requestTimeoutMs: Math.max(1, Math.ceil(Math.min(this.requestTimeoutMs, remainingMs))),
      });
      const sessionDrain = await pollClient.getSessionDrain(id, operationId);
      if (sessionDrain.status !== "draining") return sessionDrain;
      const delayMs = Math.min(pollIntervalMs, deadline - Date.now());
      if (delayMs <= 0) throw new AutoHarnessRequestTimeoutError(timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
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

  async listProviders() {
    const { items } = await this.request("/providers");
    return items;
  }

  async listCommands() {
    const { items } = await this.request("/commands");
    return items;
  }
}

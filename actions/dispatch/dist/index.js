// modules/client/src/errors.js
var AutoHarnessError = class extends Error {
  constructor(message, options) {
    super(message);
    this.name = "AutoHarnessError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.operationId = options.operationId;
    this.statusUrl = options.statusUrl;
  }
};
var AutoHarnessRequestTimeoutError = class extends Error {
  constructor(timeoutMs) {
    super(`Auto Harness request timed out after ${timeoutMs}ms`);
    this.name = "AutoHarnessRequestTimeoutError";
    this.code = "REQUEST_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
};
var AutoHarnessDrainWaitTimeoutError = class extends Error {
  constructor(repositoryId, operationId, timeoutMs) {
    super(`Auto Harness session drain wait timed out after ${timeoutMs}ms`);
    this.name = "AutoHarnessDrainWaitTimeoutError";
    this.code = "DRAIN_WAIT_TIMEOUT";
    this.repositoryId = repositoryId;
    this.operationId = operationId;
    this.timeoutMs = timeoutMs;
  }
};

// modules/client/src/resolve-by-name.js
async function resolveByName(name, catalog, kind) {
  const matches = (await catalog()).filter((entry) => entry.name === name);
  if (matches.length === 0) {
    throw new AutoHarnessError(`no ${kind} named "${name}"`, {
      status: 400,
      code: `UNKNOWN_${kind.toUpperCase()}_NAME`
    });
  }
  if (matches.length > 1) {
    throw new AutoHarnessError(
      `ambiguous ${kind} name "${name}": ${matches.length} ${kind === "repository" ? "repositories" : `${kind}s`} share this name`,
      { status: 400, code: `AMBIGUOUS_${kind.toUpperCase()}_NAME` }
    );
  }
  return matches[0].id;
}

// modules/client/src/resolve-repository.js
async function listAllRepositories(client2) {
  const items = [];
  let page = await client2.listRepositories();
  items.push(...page.items);
  while (page.nextCursor) {
    page = await client2.listRepositories({ cursor: page.nextCursor });
    items.push(...page.items);
  }
  return items;
}
async function resolveRepositoryId(client2, ref) {
  if (typeof ref === "string") return ref;
  if (ref.repositoryId !== void 0) return ref.repositoryId;
  return resolveByName(ref.repositoryName, () => listAllRepositories(client2), "repository");
}

// modules/client/src/resolve-target.js
async function resolveRef(ref, providers, commands) {
  if (ref == null || typeof ref !== "object") return ref;
  if (ref.providerId !== void 0 || ref.commandId !== void 0) return ref;
  if (ref.providerName !== void 0) {
    return { providerId: await resolveByName(ref.providerName, providers, "provider") };
  }
  if (ref.commandName !== void 0) {
    return { commandId: await resolveByName(ref.commandName, commands, "command") };
  }
  return ref;
}
async function resolveCreateSessionTargets(client2, input2) {
  let providersPromise;
  let commandsPromise;
  const providers = () => providersPromise ??= client2.listProviders();
  const commands = () => commandsPromise ??= client2.listCommands();
  const target = await resolveRef(input2.target, providers, commands);
  const repositoryId = await resolveRepositoryId(
    client2,
    input2.repositoryId !== void 0 ? input2.repositoryId : { repositoryName: input2.repositoryName }
  );
  const resolved = { ...input2, repositoryId, target };
  delete resolved.repositoryName;
  if (input2.fallbacks === void 0) return resolved;
  const fallbacks = await Promise.all(
    input2.fallbacks.map((fallback) => resolveRef(fallback, providers, commands))
  );
  return { ...resolved, fallbacks };
}

// modules/client/src/index.js
var AutoHarnessClient = class _AutoHarnessClient {
  constructor(options) {
    if (!options?.baseUrl) throw new TypeError("baseUrl is required");
    const requestTimeoutMs2 = options.requestTimeoutMs === void 0 ? 3e4 : options.requestTimeoutMs;
    if (!Number.isFinite(requestTimeoutMs2) || requestTimeoutMs2 <= 0 || requestTimeoutMs2 > 3e5) {
      throw new TypeError(
        "requestTimeoutMs must be a finite positive number no greater than 300000"
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "").replace(/\/api\/v1$/, "");
    this.apiKey = options.apiKey;
    this.allowInsecureHttp = Boolean(options.allowInsecureHttp);
    if (this.apiKey && !this.allowInsecureHttp && !this.baseUrl.startsWith("https://")) {
      throw new TypeError(
        "baseUrl must use https when apiKey is set (pass allowInsecureHttp: true for a trusted local deployment)"
      );
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    if (!this.fetch) throw new TypeError("fetch is required");
    this.requestTimeoutMs = requestTimeoutMs2;
  }
  async request(path, init = {}) {
    const headers = { accept: "application/json", ...init.headers };
    if (init.body !== void 0) headers["content-type"] = "application/json";
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
        signal: controller.signal
      });
      const body = response.status === 204 ? void 0 : await response.json().catch((error) => {
        if (controller.signal.aborted) throw error;
        return void 0;
      });
      if (!response.ok) {
        const error = body?.error;
        throw new AutoHarnessError(
          error?.message ?? `Auto Harness request failed (${response.status})`,
          {
            status: response.status,
            code: error?.code ?? "HTTP_ERROR",
            retryAfter: response.headers.get("retry-after") ?? void 0,
            operationId: error?.operationId,
            statusUrl: error?.statusUrl
          }
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
  async createSession(input2) {
    const body = await resolveCreateSessionTargets(this, input2);
    return this.request("/sessions", { method: "POST", body: JSON.stringify(body) });
  }
  getSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}`);
  }
  cancelSession(id) {
    return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }
  /** Resume a previously assigned session on its pinned host, native CLI resume where supported. */
  resumeSession(id, input2) {
    return this.request(`/sessions/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      ...input2 === void 0 ? {} : { body: JSON.stringify(input2) }
    });
  }
  listSessions(options = {}) {
    const query = new URLSearchParams();
    if (options.status !== void 0) query.set("status", options.status);
    if (options.repositoryId !== void 0) query.set("repositoryId", options.repositoryId);
    if (options.hostId !== void 0) query.set("hostId", options.hostId);
    if (options.source !== void 0) query.set("source", options.source);
    if (options.sort !== void 0) query.set("sort", options.sort);
    if (options.limit !== void 0) query.set("limit", String(options.limit));
    if (options.cursor !== void 0) query.set("cursor", options.cursor);
    if (options.concurrencyId !== void 0) query.set("concurrencyId", options.concurrencyId);
    if (options.scheduleId !== void 0) query.set("scheduleId", options.scheduleId);
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
      ...options.idempotencyKey === void 0 ? {} : { headers: { "idempotency-key": options.idempotencyKey } }
    });
  }
  /** Get bounded durable progress or terminal proof for one principal session drain. */
  async getSessionDrain(repositoryId, operationId) {
    const id = await resolveRepositoryId(this, repositoryId);
    return this.request(
      `/repositories/${encodeURIComponent(id)}/session-drains/${encodeURIComponent(operationId)}`
    );
  }
  /** Explicitly reopen admission after a succeeded or failed principal session drain. */
  async releaseSessionDrain(repositoryId, operationId) {
    const id = await resolveRepositoryId(this, repositoryId);
    return this.request(
      `/repositories/${encodeURIComponent(id)}/session-drains/${encodeURIComponent(operationId)}/release`,
      { method: "POST" }
    );
  }
  /**
   * Resolves `repositoryId`, then polls `getSessionDrain()` until it reports a terminal status,
   * clamping every request — including each page fetched to resolve a `repositoryName` — to the
   * time remaining before `timeoutMs`, recomputed fresh per request, so no single request can
   * outlive the overall wait. Resolves with the terminal `SessionDrain` for any status, including
   * "failed" and "released" — callers classify success themselves. Rejects with
   * `AutoHarnessDrainWaitTimeoutError` when the overall `timeoutMs` budget elapses — including
   * when a clamped request is the thing that times out at that same instant — or with
   * `AutoHarnessRequestTimeoutError` if an individual request times out while budget still
   * remains (e.g. a slow server response, well inside `timeoutMs`).
   */
  async waitForSessionDrain(repositoryId, operationId, options = {}) {
    const { pollIntervalMs, timeoutMs } = options;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
      throw new TypeError("pollIntervalMs must be a finite positive number");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError("timeoutMs must be a finite positive number");
    const deadline = Date.now() + timeoutMs;
    const clampedClient = () => new _AutoHarnessClient({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      allowInsecureHttp: this.allowInsecureHttp,
      fetch: this.fetch,
      requestTimeoutMs: Math.max(
        1,
        Math.ceil(Math.min(this.requestTimeoutMs, deadline - Date.now()))
      )
    });
    const rejectAtDeadline = (error, idForError) => error instanceof AutoHarnessRequestTimeoutError && Date.now() >= deadline ? new AutoHarnessDrainWaitTimeoutError(idForError, operationId, timeoutMs) : error;
    const id = await resolveRepositoryId(
      { listRepositories: (listOptions) => clampedClient().listRepositories(listOptions) },
      repositoryId
    ).catch((error) => {
      throw rejectAtDeadline(error, repositoryId);
    });
    for (; ; ) {
      if (deadline - Date.now() <= 0) {
        throw new AutoHarnessDrainWaitTimeoutError(id, operationId, timeoutMs);
      }
      const sessionDrain = await clampedClient().getSessionDrain(id, operationId).catch((error) => {
        throw rejectAtDeadline(error, id);
      });
      if (sessionDrain.status !== "draining") return sessionDrain;
      const delayMs = Math.min(pollIntervalMs, deadline - Date.now());
      if (delayMs <= 0) throw new AutoHarnessDrainWaitTimeoutError(id, operationId, timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  listRepositories(options = {}) {
    const query = new URLSearchParams();
    if (options.limit !== void 0) query.set("limit", String(options.limit));
    if (options.cursor !== void 0) query.set("cursor", options.cursor);
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
};

// modules/client/src/actions/errors.js
var HarnessDispatchError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};

// modules/client/src/actions/parse.js
var MAX_CONCURRENCY_ID_CHARACTERS = 128;
var MAX_CONCURRENCY_ID_BYTES = 2048;
var MAX_METADATA_BYTES = 8192;
function parseRequiredLabels(value, fieldName = "HARNESS_REQUIRED_LABELS") {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_REQUIRED_LABELS", `${fieldName} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((label) => typeof label === "string" && label !== "")) {
    throw new HarnessDispatchError(
      "INVALID_REQUIRED_LABELS",
      `${fieldName} must be a JSON array of strings`
    );
  }
  return parsed;
}
function parseConcurrencyId(value, { fieldName = "HARNESS_CONCURRENCY_ID", optional = false, allowAnyCharacters = false } = {}) {
  const concurrencyId = value?.trim();
  if (!concurrencyId) {
    if (optional) return void 0;
    throw new HarnessDispatchError("INVALID_CONCURRENCY_ID", `${fieldName} is required`);
  }
  if (allowAnyCharacters) {
    if (Buffer.byteLength(concurrencyId, "utf8") > MAX_CONCURRENCY_ID_BYTES) {
      throw new HarnessDispatchError(
        "INVALID_CONCURRENCY_ID",
        `${fieldName} exceeds ${MAX_CONCURRENCY_ID_BYTES} bytes`
      );
    }
    return concurrencyId;
  }
  if (concurrencyId.length > MAX_CONCURRENCY_ID_CHARACTERS) {
    throw new HarnessDispatchError("INVALID_CONCURRENCY_ID", `${fieldName} exceeds 128 characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(concurrencyId)) {
    throw new HarnessDispatchError(
      "INVALID_CONCURRENCY_ID",
      `${fieldName} contains unsupported characters`
    );
  }
  return concurrencyId;
}
function parseMetadata(value, fieldName = "HARNESS_METADATA") {
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} must be a JSON object`);
  }
  for (const [key, fieldValue] of Object.entries(parsed)) {
    const isValidScalar = ["string", "boolean"].includes(typeof fieldValue) || fieldValue === null || typeof fieldValue === "number" && Number.isFinite(fieldValue);
    if (!isValidScalar) {
      throw new HarnessDispatchError(
        "INVALID_METADATA",
        `${fieldName}.${key} must be a string, finite number, boolean, or null`
      );
    }
  }
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_METADATA_BYTES) {
    throw new HarnessDispatchError("INVALID_METADATA", `${fieldName} exceeds 8192 bytes`);
  }
  return parsed;
}
function parseApiOrigin(rawUrl, { fieldName = "HARNESS_URL", allowHttp = false } = {}) {
  let apiUrl;
  try {
    apiUrl = new URL(rawUrl);
  } catch {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", `${fieldName} must be a valid URL`);
  }
  const protocolLabel = allowHttp ? "http or https" : "https";
  if (apiUrl.protocol !== "https:" && !(allowHttp && apiUrl.protocol === "http:")) {
    throw new HarnessDispatchError("INVALID_HARNESS_URL", `${fieldName} must use ${protocolLabel}`);
  }
  const { origin } = apiUrl;
  if (apiUrl.username !== "" || apiUrl.password !== "" || apiUrl.search !== "" || apiUrl.hash !== "" || ![origin, `${origin}/`, `${origin}/api/v1`, `${origin}/api/v1/`].includes(rawUrl)) {
    throw new HarnessDispatchError(
      "INVALID_HARNESS_URL",
      `${fieldName} must be an exact ${protocolLabel} origin, optionally suffixed with /api/v1`
    );
  }
  return new URL(origin);
}

// modules/client/src/actions/parse-target.js
var TARGET_SPEC_KEYS = ["providerId", "providerName", "commandId", "commandName"];
function parseTargetRefValue(parsed, key) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_TARGET", `${key} must be a JSON object`);
  }
  const rest = Object.keys(parsed).filter((field2) => !TARGET_SPEC_KEYS.includes(field2));
  if (rest.length > 0) {
    throw new HarnessDispatchError(
      "INVALID_TARGET",
      `${key} must only contain providerId, providerName, commandId, or commandName`
    );
  }
  const presentKeys = TARGET_SPEC_KEYS.filter((field2) => field2 in parsed);
  if (presentKeys.length !== 1) {
    throw new HarnessDispatchError(
      "INVALID_TARGET",
      `${key} must be exactly one of providerId, providerName, commandId, or commandName`
    );
  }
  const field = presentKeys[0];
  const fieldValue = parsed[field];
  if (typeof fieldValue !== "string" || fieldValue === "") {
    throw new HarnessDispatchError("INVALID_TARGET", `${key}.${field} must be a non-empty string`);
  }
  return { [field]: fieldValue };
}
function parseHarnessTarget(value, fieldName = "HARNESS_TARGET") {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_TARGET", `${fieldName} must be valid JSON`);
  }
  return parseTargetRefValue(parsed, fieldName);
}
function parseHarnessFallbacks(value, fieldName = "HARNESS_FALLBACKS") {
  if (!value?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HarnessDispatchError("INVALID_FALLBACKS", `${fieldName} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new HarnessDispatchError("INVALID_FALLBACKS", `${fieldName} must be a JSON array`);
  }
  return parsed.map((entry, index) => parseTargetRefValue(entry, `${fieldName}[${index}]`));
}

// actions/dispatch/src/client.ts
function client(options) {
  return new AutoHarnessClient(options);
}

// actions/dispatch/src/io.ts
import { appendFileSync } from "node:fs";
function input(name, required = false) {
  const value = process.env[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`]?.trim() ?? "";
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}
function parsePositiveNumber(name, raw, maximum, integer = false) {
  const value = Number(raw);
  const kind = integer ? "integer" : "number";
  if (!Number.isFinite(value) || value <= 0 || maximum !== void 0 && value > maximum || integer && !Number.isInteger(value)) {
    throw new Error(
      maximum === void 0 ? `${name} must be a positive ${kind}` : `${name} must be a finite positive ${kind} no greater than ${maximum}`
    );
  }
  return value;
}
function positiveNumberInput(name, maximum) {
  return parsePositiveNumber(name, input(name, true), maximum);
}
function optionalPositiveNumberInput(name, maximum, integer = false) {
  const raw = input(name);
  return raw ? parsePositiveNumber(name, raw, maximum, integer) : void 0;
}
function optionalBoundedNumberInput(name, minimum, maximum) {
  const raw = input(name);
  if (!raw) return void 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite integer between ${minimum} and ${maximum}`);
  }
  return value;
}
function requestTimeoutMs() {
  const value = Number(input("request-timeout-seconds") || "30");
  if (!Number.isFinite(value) || value <= 0 || value > 300) {
    throw new Error("request-timeout-seconds must be a finite positive number no greater than 300");
  }
  return value * 1e3;
}
function setOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}
`, "utf8");
}
function escapeWorkflowCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

// actions/dispatch/src/validation.ts
var drainStatuses = /* @__PURE__ */ new Set(["draining", "succeeded", "failed", "released"]);
function record(value, malformedMessage) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(malformedMessage);
  }
  return value;
}
function absoluteApiUrl(baseUrl, statusUrl) {
  if (typeof statusUrl !== "string" || !statusUrl.startsWith("/api/v1/")) {
    throw new Error("Auto Harness returned a malformed principal session drain statusUrl");
  }
  return new URL(statusUrl, `${baseUrl}/`).toString();
}
function validateDrain(value, baseUrl, repositoryId, expectedOperationId) {
  const result = record(
    value,
    "Auto Harness returned a malformed principal session drain response"
  );
  if (typeof result.operationId !== "string" || !result.operationId || /[\r\n]/.test(result.operationId)) {
    throw new Error("Auto Harness returned a principal session drain without an operationId");
  }
  if (expectedOperationId !== void 0 && result.operationId !== expectedOperationId) {
    throw new Error("Auto Harness returned a different principal session drain operation");
  }
  if (result.repositoryId !== repositoryId) {
    throw new Error("Auto Harness returned a principal session drain for a different repository");
  }
  if (!drainStatuses.has(result.status)) {
    throw new Error("Auto Harness returned an unknown principal session drain status");
  }
  for (const name of ["queuedCount", "runningCount", "cancelledCount"]) {
    if (!Number.isSafeInteger(result[name]) || Number(result[name]) < 0) {
      throw new Error(`Auto Harness returned an invalid principal session drain ${name}`);
    }
  }
  if (result.failureCode !== void 0 && (typeof result.failureCode !== "string" || /[\r\n]/.test(result.failureCode))) {
    throw new Error("Auto Harness returned an invalid principal session drain failureCode");
  }
  const statusUrl = absoluteApiUrl(baseUrl, result.statusUrl);
  const expectedPath = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`;
  if (new URL(statusUrl).pathname !== expectedPath) {
    throw new Error(
      "Auto Harness returned a principal session drain statusUrl for a different operation"
    );
  }
  return {
    operationId: result.operationId,
    repositoryId,
    status: result.status,
    statusUrl,
    queuedCount: Number(result.queuedCount),
    runningCount: Number(result.runningCount),
    cancelledCount: Number(result.cancelledCount),
    ...result.failureCode === void 0 ? {} : { failureCode: result.failureCode }
  };
}
function validateSession(value) {
  const result = record(value, "Auto Harness returned a malformed session response");
  if (typeof result.id !== "string" || !result.id || /[\r\n]/.test(result.id)) {
    throw new Error("Auto Harness returned a session without a valid id");
  }
  if (typeof result.url !== "string" || !result.url || /[\r\n]/.test(result.url)) {
    throw new Error("Auto Harness returned a session without a valid url");
  }
  if (typeof result.created !== "boolean") {
    throw new TypeError("Auto Harness returned a session without a created result");
  }
  return { id: result.id, url: result.url, created: result.created };
}
function setDrainOutputs(result) {
  setOutput("operation-id", result.operationId);
  setOutput("status-url", result.statusUrl);
  setOutput("drain-status", result.status);
  setOutput("drain-terminal", String(result.status !== "draining"));
  setOutput("queued-count", String(result.queuedCount));
  setOutput("running-count", String(result.runningCount));
  setOutput("cancelled-count", String(result.cancelledCount));
  setOutput("failure-code", result.failureCode ?? "");
}
function actionErrorMessage(error, baseUrl) {
  if (error instanceof AutoHarnessDrainWaitTimeoutError) {
    return "Timed out waiting for principal session drain";
  }
  if (error instanceof AutoHarnessRequestTimeoutError) {
    return "Timed out waiting for Auto Harness request";
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

// actions/dispatch/src/drain.ts
async function waitForSucceededDrain(options, repositoryId, operationId) {
  const pollIntervalMs = positiveNumberInput("poll-interval-seconds") * 1e3;
  const timeoutMs = positiveNumberInput("poll-timeout-seconds") * 1e3;
  const response = await client(options).waitForSessionDrain(repositoryId, operationId, {
    pollIntervalMs,
    timeoutMs
  });
  const result = validateDrain(response, options.baseUrl, repositoryId, operationId);
  if (result.status !== "succeeded") {
    setDrainOutputs(result);
    const failure = result.failureCode ? ` (${result.failureCode})` : "";
    throw new Error(`Principal session drain did not succeed: ${result.status}${failure}`);
  }
  return result;
}
async function startDrain(options, repositoryId) {
  const idempotencyKey = input("idempotency-key");
  const response = await client(options).startSessionDrain(
    repositoryId,
    idempotencyKey ? { idempotencyKey } : {}
  );
  const result = validateDrain(response, options.baseUrl, repositoryId);
  if (result.status !== "draining" && result.status !== "succeeded") {
    setDrainOutputs(result);
    throw new Error(
      `Auto Harness did not start an active principal session drain: ${result.status}`
    );
  }
  return result;
}
async function existingDrain(operation, options, repositoryId) {
  const operationId = input("session-drain-id", true);
  if (operation === "wait-for-drain") {
    return waitForSucceededDrain(options, repositoryId, operationId);
  }
  const response = operation === "release-drain" ? await client(options).releaseSessionDrain(repositoryId, operationId) : await client(options).getSessionDrain(repositoryId, operationId);
  const result = validateDrain(response, options.baseUrl, repositoryId, operationId);
  if (operation === "release-drain" && result.status !== "released") {
    setDrainOutputs(result);
    throw new Error(`Auto Harness did not release principal session drain: ${result.status}`);
  }
  return result;
}
async function drain(operation, options, repositoryId) {
  const result = operation === "start-drain" ? await startDrain(options, repositoryId) : await existingDrain(operation, options, repositoryId);
  setDrainOutputs(result);
  process.stdout.write(`Auto Harness session drain ${result.operationId}: ${result.status}
`);
}

// actions/dispatch/src/index.ts
var PRIORITY_MIN = -1e4;
var PRIORITY_MAX = 1e4;
var QUEUE_TTL_MAX_SECONDS = 2592e3;
var RESUME_TIMEOUT_MAX_SECONDS = 604800;
function operationInput() {
  const operation = input("operation") || "dispatch";
  if (operation !== "dispatch" && operation !== "resume" && operation !== "start-drain" && operation !== "get-drain" && operation !== "wait-for-drain" && operation !== "release-drain") {
    throw new Error(
      `operation must be dispatch, resume, start-drain, get-drain, wait-for-drain, or release-drain; received ${operation}`
    );
  }
  return operation;
}
function sourceInput() {
  const source = input("source");
  if (!source) return void 0;
  if (source !== "api" && source !== "ui" && source !== "webhook") {
    throw new Error(`source must be api, ui, or webhook; received ${source}`);
  }
  return source;
}
function requiredLabelsInput() {
  return parseRequiredLabels(input("required-labels"), "required-labels");
}
async function dispatch(options, repositoryId) {
  const fallbacks = input("fallbacks");
  const ref = input("ref");
  const concurrencyId = parseConcurrencyId(input("concurrency-id"), {
    fieldName: "concurrency-id",
    optional: true,
    allowAnyCharacters: true
  });
  const requiredLabels = requiredLabelsInput();
  const metadata = input("metadata");
  const source = sourceInput();
  const queueTtlSeconds = optionalPositiveNumberInput(
    "queue-ttl-seconds",
    QUEUE_TTL_MAX_SECONDS,
    true
  );
  const priority = optionalBoundedNumberInput("priority", PRIORITY_MIN, PRIORITY_MAX);
  const request = {
    repositoryId,
    prompt: input("prompt", true),
    target: parseHarnessTarget(input("target", true), "target"),
    timeout: positiveNumberInput("timeout"),
    ...fallbacks ? { fallbacks: parseHarnessFallbacks(fallbacks, "fallbacks") } : {},
    ...ref ? { ref } : {},
    ...concurrencyId ? { concurrencyId } : {},
    ...queueTtlSeconds !== void 0 ? { queueTtlSeconds } : {},
    ...priority !== void 0 ? { priority } : {},
    ...requiredLabels.length > 0 ? { requiredLabels } : {},
    ...metadata ? { metadata: parseMetadata(metadata, "metadata") } : {},
    ...source ? { source } : {}
  };
  const session = validateSession(await client(options).createSession(request));
  setOutput("session-id", session.id);
  setOutput("session-url", session.url);
  setOutput("created", String(session.created));
  process.stdout.write(`Dispatched Auto Harness session ${session.id}
`);
}
async function resume(options) {
  const sessionId = input("session-id", true);
  const prompt = input("prompt");
  const concurrencyId = parseConcurrencyId(input("concurrency-id"), {
    fieldName: "concurrency-id",
    optional: true,
    allowAnyCharacters: true
  });
  const timeout = optionalPositiveNumberInput("timeout", RESUME_TIMEOUT_MAX_SECONDS);
  const priority = optionalBoundedNumberInput("priority", PRIORITY_MIN, PRIORITY_MAX);
  const request = {
    ...prompt ? { prompt } : {},
    ...concurrencyId ? { concurrencyId } : {},
    ...timeout !== void 0 ? { timeout } : {},
    ...priority !== void 0 ? { priority } : {}
  };
  const session = validateSession(await client(options).resumeSession(sessionId, request));
  setOutput("session-id", session.id);
  setOutput("session-url", session.url);
  setOutput("created", String(session.created));
  process.stdout.write(`Resumed Auto Harness session ${session.id}
`);
}
async function main() {
  const baseUrl = parseApiOrigin(input("server-url", true), {
    fieldName: "server-url",
    allowHttp: true
  }).origin;
  const operation = operationInput();
  const options = {
    baseUrl,
    apiKey: input("api-key", true),
    requestTimeoutMs: requestTimeoutMs(),
    // The Action's own server-url input already opts into plain HTTP (allowHttp above) for
    // self-hosted deployments reachable only on a private network; carry that same intent here.
    allowInsecureHttp: true
  };
  try {
    if (operation === "dispatch") await dispatch(options, input("repository-id", true));
    else if (operation === "resume") await resume(options);
    else await drain(operation, options, input("repository-id", true));
  } catch (error) {
    throw new Error(actionErrorMessage(error, baseUrl), { cause: error });
  }
}
try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`::error::${escapeWorkflowCommand(message)}
`);
  process.exitCode = 1;
}

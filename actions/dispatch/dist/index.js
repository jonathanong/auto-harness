import { appendFileSync } from "node:fs";

const input = (name, required = false) => {
  const value = process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`]?.trim();
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
};

const parseJson = (name, value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
};

const setOutput = (name, value) => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}\n`, "utf8");
};

const positiveNumberInput = (name, maximum) => {
  const value = Number(input(name, true));
  if (!Number.isFinite(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive number`
        : `${name} must be a finite positive number no greater than ${maximum}`,
    );
  }
  return value;
};

const requestTimeoutSeconds = () => {
  const value = Number(input("request-timeout-seconds") || "30");
  if (!Number.isFinite(value) || value <= 0 || value > 300) {
    throw new Error("request-timeout-seconds must be a finite positive number no greater than 300");
  }
  return value;
};

const drainStatuses = new Set(["draining", "succeeded", "failed", "released"]);

const absoluteApiUrl = (baseUrl, statusUrl) => {
  if (typeof statusUrl !== "string" || !statusUrl.startsWith("/api/v1/")) {
    throw new Error("Auto Harness returned a malformed principal session drain statusUrl");
  }
  return new URL(statusUrl, `${baseUrl}/`).toString();
};

const validateDrain = (result, baseUrl, repositoryId, expectedOperationId) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Auto Harness returned a malformed principal session drain response");
  }
  if (typeof result.operationId !== "string" || !result.operationId || /[\r\n]/.test(result.operationId)) {
    throw new Error("Auto Harness returned a principal session drain without an operationId");
  }
  if (expectedOperationId !== undefined && result.operationId !== expectedOperationId) {
    throw new Error("Auto Harness returned a different principal session drain operation");
  }
  if (result.repositoryId !== repositoryId) {
    throw new Error("Auto Harness returned a principal session drain for a different repository");
  }
  if (!drainStatuses.has(result.status)) {
    throw new Error("Auto Harness returned an unknown principal session drain status");
  }
  for (const name of ["queuedCount", "runningCount", "cancelledCount"]) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 0) {
      throw new Error(`Auto Harness returned an invalid principal session drain ${name}`);
    }
  }
  if (result.failureCode !== undefined && (typeof result.failureCode !== "string" || /[\r\n]/.test(result.failureCode))) {
    throw new Error("Auto Harness returned an invalid principal session drain failureCode");
  }
  const statusUrl = absoluteApiUrl(baseUrl, result.statusUrl);
  const expectedPath = `/api/v1/repositories/${encodeURIComponent(repositoryId)}/session-drains/${encodeURIComponent(result.operationId)}`;
  if (new URL(statusUrl).pathname !== expectedPath) {
    throw new Error("Auto Harness returned a principal session drain statusUrl for a different operation");
  }
  return { ...result, statusUrl };
};

const validateSession = (result) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Auto Harness returned a malformed session response");
  }
  if (typeof result.id !== "string" || !result.id || /[\r\n]/.test(result.id)) {
    throw new Error("Auto Harness returned a session without a valid id");
  }
  if (typeof result.url !== "string" || !result.url || /[\r\n]/.test(result.url)) {
    throw new Error("Auto Harness returned a session without a valid url");
  }
  if (typeof result.created !== "boolean") {
    throw new Error("Auto Harness returned a session without a created result");
  }
  return result;
};

const drainErrorDetails = (baseUrl, error) => {
  if (!error || typeof error !== "object" || typeof error.statusUrl !== "string") return "";
  try {
    return `; drain ${typeof error.operationId === "string" ? error.operationId : "unknown"}: ${absoluteApiUrl(baseUrl, error.statusUrl)}`;
  } catch {
    return "";
  }
};

const request = async (baseUrl, apiKey, path, method = "GET", headers = {}, options = {}) => {
  const { body, deadline, drain: isDrain, timeoutMs } = options;
  const remainingMs = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Timed out waiting for principal session drain");
  const signal = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(timeoutMs, remainingMs))));
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
      signal,
    });
    const result = await response.json().catch((error) => {
      if (signal.aborted) throw error;
      return {};
    });
    if (!response.ok) {
      const drain = drainErrorDetails(baseUrl, result.error);
      throw new Error(result.error?.message ? `${result.error.message}${drain}` : `Auto Harness returned ${response.status}`);
    }
    return result;
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        isDrain || deadline !== undefined
          ? "Timed out waiting for principal session drain"
          : "Timed out waiting for Auto Harness request",
      );
    }
    throw error;
  }
};

const setDrainOutputs = (result) => {
  setOutput("operation-id", result.operationId);
  setOutput("status-url", result.statusUrl);
  setOutput("drain-status", result.status);
  setOutput("drain-terminal", String(result.status !== "draining"));
  setOutput("queued-count", String(result.queuedCount));
  setOutput("running-count", String(result.runningCount));
  setOutput("cancelled-count", String(result.cancelledCount));
  setOutput("failure-code", result.failureCode ?? "");
};

const waitForSucceededDrain = async (baseUrl, apiKey, path, repositoryId, operationId, requestTimeoutMs) => {
  const intervalMs = positiveNumberInput("poll-interval-seconds") * 1_000;
  const deadline = Date.now() + positiveNumberInput("poll-timeout-seconds") * 1_000;
  let result = validateDrain(
    await request(baseUrl, apiKey, path, "GET", {}, { deadline, drain: true, timeoutMs: requestTimeoutMs }),
    baseUrl,
    repositoryId,
    operationId,
  );
  while (result.status === "draining") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Timed out waiting for principal session drain");
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
    result = validateDrain(
      await request(baseUrl, apiKey, path, "GET", {}, { deadline, drain: true, timeoutMs: requestTimeoutMs }),
      baseUrl,
      repositoryId,
      operationId,
    );
  }
  if (result.status !== "succeeded") {
    setDrainOutputs(result);
    const failure = result.failureCode ? ` (${result.failureCode})` : "";
    throw new Error(`Principal session drain did not succeed: ${result.status}${failure}`);
  }
  return result;
};

try {
  const baseUrl = input("server-url", true).replace(/\/$/, "").replace(/\/api\/v1$/, "");
  const apiKey = input("api-key", true);
  const requestTimeoutMs = requestTimeoutSeconds() * 1_000;
  const operation = input("operation") || "dispatch";
  const repositoryId = input("repository-id", true);
  if (operation === "dispatch") {
    const body = {
      repositoryId,
      prompt: input("prompt", true),
      target: parseJson("target", input("target", true)),
      timeout: positiveNumberInput("timeout"),
      ...(input("fallbacks") ? { fallbacks: parseJson("fallbacks", input("fallbacks")) } : {}),
      ...(input("ref") ? { ref: input("ref") } : {}),
      ...(input("concurrency-id") ? { concurrencyId: input("concurrency-id") } : {}),
      ...(input("metadata") ? { metadata: parseJson("metadata", input("metadata")) } : {}),
    };
    const result = await request(baseUrl, apiKey, "/sessions", "POST", {
      "content-type": "application/json",
    }, { body: JSON.stringify(body), timeoutMs: requestTimeoutMs });
    const session = validateSession(result);
    setOutput("session-id", session.id);
    setOutput("session-url", session.url);
    setOutput("created", String(session.created));
    process.stdout.write(`Dispatched Auto Harness session ${session.id}\n`);
  } else {
    const collection = `/repositories/${encodeURIComponent(repositoryId)}/session-drains`;
    const drainId = input("session-drain-id");
    let result;
    if (operation === "start-drain") {
      result = validateDrain(
        await request(baseUrl, apiKey, collection, "POST", {
          ...(input("idempotency-key") ? { "idempotency-key": input("idempotency-key") } : {}),
        }, { drain: true, timeoutMs: requestTimeoutMs }),
        baseUrl,
        repositoryId,
      );
      if (result.status !== "draining" && result.status !== "succeeded") {
        setDrainOutputs(result);
        throw new Error(`Auto Harness did not start an active principal session drain: ${result.status}`);
      }
    } else if (operation === "get-drain" || operation === "release-drain" || operation === "wait-for-drain") {
      if (!drainId) throw new Error("Input required and not supplied: session-drain-id");
      const path = `${collection}/${encodeURIComponent(drainId)}`;
      if (operation === "wait-for-drain") {
        result = await waitForSucceededDrain(baseUrl, apiKey, path, repositoryId, drainId, requestTimeoutMs);
      } else {
        result = validateDrain(
          await request(
            baseUrl,
            apiKey,
            operation === "release-drain" ? `${path}/release` : path,
            operation === "release-drain" ? "POST" : "GET",
            {},
            { drain: true, timeoutMs: requestTimeoutMs },
          ),
          baseUrl,
          repositoryId,
          drainId,
        );
        if (operation === "release-drain" && result.status !== "released") {
          throw new Error(`Auto Harness did not release principal session drain: ${result.status}`);
        }
      }
    } else {
      throw new Error(`operation must be dispatch, start-drain, get-drain, wait-for-drain, or release-drain; received ${operation}`);
    }
    setDrainOutputs(result);
    process.stdout.write(`Auto Harness session drain ${result.operationId}: ${result.status}\n`);
  }
} catch (error) {
  process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

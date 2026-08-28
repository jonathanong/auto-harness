import {
  AutoHarnessClient,
  type CreateSessionInput,
  type SessionDrain,
  type SessionMetadataValue,
  type TargetSpec,
} from "auto-harness-client";

import {
  escapeWorkflowCommand,
  input,
  parseJson,
  positiveNumberInput,
  requestTimeoutMs,
  setOutput,
} from "./io.ts";
import {
  actionErrorMessage,
  setDrainOutputs,
  validateDrain,
  validateSession,
  type ValidatedDrain,
} from "./validation.ts";

type Operation = "dispatch" | "start-drain" | "get-drain" | "wait-for-drain" | "release-drain";
type DrainOperation = Exclude<Operation, "dispatch">;
type ExistingDrainOperation = Exclude<DrainOperation, "start-drain">;

type ClientOptions = { baseUrl: string; apiKey: string; requestTimeoutMs: number };

function client(options: ClientOptions): AutoHarnessClient {
  return new AutoHarnessClient(options);
}

function operationInput(): Operation {
  const operation = input("operation") || "dispatch";
  if (
    operation !== "dispatch" &&
    operation !== "start-drain" &&
    operation !== "get-drain" &&
    operation !== "wait-for-drain" &&
    operation !== "release-drain"
  ) {
    throw new Error(
      `operation must be dispatch, start-drain, get-drain, wait-for-drain, or release-drain; received ${operation}`,
    );
  }
  return operation;
}

async function dispatch(options: ClientOptions, repositoryId: string): Promise<void> {
  const fallbacks = input("fallbacks");
  const ref = input("ref");
  const concurrencyId = input("concurrency-id");
  const metadata = input("metadata");
  const request: CreateSessionInput = {
    repositoryId,
    prompt: input("prompt", true),
    target: parseJson<TargetSpec>("target", input("target", true)),
    timeout: positiveNumberInput("timeout"),
    ...(fallbacks ? { fallbacks: parseJson<TargetSpec[]>("fallbacks", fallbacks) } : {}),
    ...(ref ? { ref } : {}),
    ...(concurrencyId ? { concurrencyId } : {}),
    ...(metadata
      ? { metadata: parseJson<Record<string, SessionMetadataValue>>("metadata", metadata) }
      : {}),
  };
  const session = validateSession(await client(options).createSession(request));
  setOutput("session-id", session.id);
  setOutput("session-url", session.url);
  setOutput("created", String(session.created));
  process.stdout.write(`Dispatched Auto Harness session ${session.id}\n`);
}

async function waitForSucceededDrain(
  options: ClientOptions,
  repositoryId: string,
  operationId: string,
): Promise<ValidatedDrain> {
  const intervalMs = positiveNumberInput("poll-interval-seconds") * 1_000;
  const deadline = Date.now() + positiveNumberInput("poll-timeout-seconds") * 1_000;
  let result: ValidatedDrain;
  do {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("Timed out waiting for principal session drain");
    const timeoutOptions = {
      ...options,
      requestTimeoutMs: Math.max(1, Math.ceil(Math.min(options.requestTimeoutMs, remainingMs))),
    };
    result = validateDrain(
      await client(timeoutOptions).getSessionDrain(repositoryId, operationId),
      options.baseUrl,
      repositoryId,
      operationId,
    );
    if (result.status === "draining") {
      const delayMs = Math.min(intervalMs, deadline - Date.now());
      if (delayMs <= 0) throw new Error("Timed out waiting for principal session drain");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } while (result.status === "draining");
  if (result.status !== "succeeded") {
    setDrainOutputs(result);
    const failure = result.failureCode ? ` (${result.failureCode})` : "";
    throw new Error(`Principal session drain did not succeed: ${result.status}${failure}`);
  }
  return result;
}

async function startDrain(options: ClientOptions, repositoryId: string): Promise<ValidatedDrain> {
  const idempotencyKey = input("idempotency-key");
  const response = await client(options).startSessionDrain(
    repositoryId,
    idempotencyKey ? { idempotencyKey } : {},
  );
  const result = validateDrain(response, options.baseUrl, repositoryId);
  if (result.status !== "draining" && result.status !== "succeeded") {
    setDrainOutputs(result);
    throw new Error(
      `Auto Harness did not start an active principal session drain: ${result.status}`,
    );
  }
  return result;
}

async function existingDrain(
  operation: ExistingDrainOperation,
  options: ClientOptions,
  repositoryId: string,
): Promise<ValidatedDrain> {
  const operationId = input("session-drain-id", true);
  if (operation === "wait-for-drain") {
    return waitForSucceededDrain(options, repositoryId, operationId);
  }
  const response: SessionDrain =
    operation === "release-drain"
      ? await client(options).releaseSessionDrain(repositoryId, operationId)
      : await client(options).getSessionDrain(repositoryId, operationId);
  const result = validateDrain(response, options.baseUrl, repositoryId, operationId);
  if (operation === "release-drain" && result.status !== "released") {
    throw new Error(`Auto Harness did not release principal session drain: ${result.status}`);
  }
  return result;
}

async function drain(
  operation: DrainOperation,
  options: ClientOptions,
  repositoryId: string,
): Promise<void> {
  const result =
    operation === "start-drain"
      ? await startDrain(options, repositoryId)
      : await existingDrain(operation, options, repositoryId);
  setDrainOutputs(result);
  process.stdout.write(`Auto Harness session drain ${result.operationId}: ${result.status}\n`);
}

async function main(): Promise<void> {
  const baseUrl = input("server-url", true)
    .replace(/\/$/, "")
    .replace(/\/api\/v1$/, "");
  const operation = operationInput();
  const options = { baseUrl, apiKey: input("api-key", true), requestTimeoutMs: requestTimeoutMs() };
  try {
    const repositoryId = input("repository-id", true);
    if (operation === "dispatch") await dispatch(options, repositoryId);
    else await drain(operation, options, repositoryId);
  } catch (error) {
    throw new Error(actionErrorMessage(error, baseUrl, operation !== "dispatch"), { cause: error });
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`::error::${escapeWorkflowCommand(message)}\n`);
  process.exitCode = 1;
}

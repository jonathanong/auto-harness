import type { SessionDrain } from "auto-harness-client";

import { client, type ClientOptions } from "./client.ts";
import { input, positiveNumberInput } from "./io.ts";
import { setDrainOutputs, validateDrain, type ValidatedDrain } from "./validation.ts";

export type DrainOperation = "start-drain" | "get-drain" | "wait-for-drain" | "release-drain";
type ExistingDrainOperation = Exclude<DrainOperation, "start-drain">;

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
    setDrainOutputs(result);
    throw new Error(`Auto Harness did not release principal session drain: ${result.status}`);
  }
  return result;
}

export async function drain(
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

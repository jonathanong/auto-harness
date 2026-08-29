import {
  type CreatableSessionSource,
  type CreateSessionInput,
  type ResumeSessionInput,
  type SessionMetadataValue,
  type TargetSpec,
} from "auto-harness-client";

import { client } from "./client.ts";
import { drain, type DrainOperation } from "./drain.ts";
import {
  escapeWorkflowCommand,
  input,
  optionalBoundedNumberInput,
  optionalPositiveNumberInput,
  parseJson,
  positiveNumberInput,
  requestTimeoutMs,
  setOutput,
} from "./io.ts";
import { actionErrorMessage, validateSession } from "./validation.ts";

type Operation = "dispatch" | "resume" | DrainOperation;

const PRIORITY_MIN = -10_000;
const PRIORITY_MAX = 10_000;
const QUEUE_TTL_MAX_SECONDS = 2_592_000;
const RESUME_TIMEOUT_MAX_SECONDS = 604_800;

type ClientOptions = { baseUrl: string; apiKey: string; requestTimeoutMs: number };

function operationInput(): Operation {
  const operation = input("operation") || "dispatch";
  if (
    operation !== "dispatch" &&
    operation !== "resume" &&
    operation !== "start-drain" &&
    operation !== "get-drain" &&
    operation !== "wait-for-drain" &&
    operation !== "release-drain"
  ) {
    throw new Error(
      `operation must be dispatch, resume, start-drain, get-drain, wait-for-drain, or release-drain; received ${operation}`,
    );
  }
  return operation;
}

function sourceInput(): CreatableSessionSource | undefined {
  const source = input("source");
  if (!source) return undefined;
  if (source !== "api" && source !== "ui" && source !== "webhook") {
    throw new Error(`source must be api, ui, or webhook; received ${source}`);
  }
  return source;
}

function requiredLabelsInput(): string[] | undefined {
  const value = input("required-labels");
  if (!value) return undefined;
  const parsed = parseJson<unknown>("required-labels", value);
  if (!Array.isArray(parsed) || parsed.some((label) => typeof label !== "string")) {
    throw new Error("required-labels must be a JSON array of strings");
  }
  return parsed;
}

async function dispatch(options: ClientOptions, repositoryId: string): Promise<void> {
  const fallbacks = input("fallbacks");
  const ref = input("ref");
  const concurrencyId = input("concurrency-id");
  const requiredLabels = requiredLabelsInput();
  const metadata = input("metadata");
  const source = sourceInput();
  const queueTtlSeconds = optionalPositiveNumberInput(
    "queue-ttl-seconds",
    QUEUE_TTL_MAX_SECONDS,
    true,
  );
  const priority = optionalBoundedNumberInput("priority", PRIORITY_MIN, PRIORITY_MAX);
  const request: CreateSessionInput = {
    repositoryId,
    prompt: input("prompt", true),
    target: parseJson<TargetSpec>("target", input("target", true)),
    timeout: positiveNumberInput("timeout"),
    ...(fallbacks ? { fallbacks: parseJson<TargetSpec[]>("fallbacks", fallbacks) } : {}),
    ...(ref ? { ref } : {}),
    ...(concurrencyId ? { concurrencyId } : {}),
    ...(queueTtlSeconds !== undefined ? { queueTtlSeconds } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(requiredLabels ? { requiredLabels } : {}),
    ...(metadata
      ? { metadata: parseJson<Record<string, SessionMetadataValue>>("metadata", metadata) }
      : {}),
    ...(source ? { source } : {}),
  };
  const session = validateSession(await client(options).createSession(request));
  setOutput("session-id", session.id);
  setOutput("session-url", session.url);
  setOutput("created", String(session.created));
  process.stdout.write(`Dispatched Auto Harness session ${session.id}\n`);
}

// No queue-ttl-seconds input here: a resumed session reuses its pinned host/route rather than
// re-entering the queue, so `ResumeSessionInput` (modules/client/src/index.d.ts) and the control
// plane's resume body allowlist (RESUME_BODY_FIELDS) have no queueTtlSeconds field to set.
async function resume(options: ClientOptions): Promise<void> {
  const sessionId = input("session-id", true);
  const prompt = input("prompt");
  const concurrencyId = input("concurrency-id");
  const timeout = optionalPositiveNumberInput("timeout", RESUME_TIMEOUT_MAX_SECONDS);
  const priority = optionalBoundedNumberInput("priority", PRIORITY_MIN, PRIORITY_MAX);
  const request: ResumeSessionInput = {
    ...(prompt ? { prompt } : {}),
    ...(concurrencyId ? { concurrencyId } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };
  const session = validateSession(await client(options).resumeSession(sessionId, request));
  setOutput("session-id", session.id);
  setOutput("session-url", session.url);
  setOutput("created", String(session.created));
  process.stdout.write(`Resumed Auto Harness session ${session.id}\n`);
}

async function main(): Promise<void> {
  const baseUrl = input("server-url", true)
    .replace(/\/$/, "")
    .replace(/\/api\/v1$/, "");
  const operation = operationInput();
  const options = { baseUrl, apiKey: input("api-key", true), requestTimeoutMs: requestTimeoutMs() };
  try {
    if (operation === "dispatch") await dispatch(options, input("repository-id", true));
    else if (operation === "resume") await resume(options);
    else await drain(operation, options, input("repository-id", true));
  } catch (error) {
    throw new Error(
      actionErrorMessage(error, baseUrl, operation !== "dispatch" && operation !== "resume"),
      { cause: error },
    );
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`::error::${escapeWorkflowCommand(message)}\n`);
  process.exitCode = 1;
}

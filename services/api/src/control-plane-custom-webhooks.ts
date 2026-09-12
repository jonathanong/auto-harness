/* eslint-disable max-lines -- generic webhook config owns validation, KMS, and CAS lifecycle. */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_QUEUE_TTL_SECONDS,
  validateTargetRouting,
  sessionPriorityError,
  sessionTimeoutError,
  MAX_REQUIRED_LABELS,
  MAX_REQUIRED_LABEL_LENGTH,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  customWebhookEncryptionContext,
  toPublicCustomWebhookIntegration,
  type CustomWebhookConfigInput,
  type PublicCustomWebhookIntegration,
} from "./custom-webhook-types.ts";
import type { CustomWebhookIntegrationRecord } from "./db/plane-storage-types.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";

type Failure = { ok: false; error: string; conflict?: true; unavailable?: true };

export async function getCustomWebhookIntegration(
  state: ControlPlaneState,
  id: string,
): Promise<PublicCustomWebhookIntegration | null> {
  const record = state.storage
    ? await state.storage.getCustomWebhookIntegration(id)
    : state.customWebhookIntegrations.get(id);
  if (!record) return null;
  state.customWebhookIntegrations.set(id, record);
  return toPublicCustomWebhookIntegration(record);
}

export async function getCustomWebhookIntegrationRecord(
  state: ControlPlaneState,
  id: string,
): Promise<CustomWebhookIntegrationRecord | null> {
  const record = state.storage
    ? await state.storage.getCustomWebhookIntegration(id)
    : state.customWebhookIntegrations.get(id);
  if (record) state.customWebhookIntegrations.set(id, record);
  return record ?? null;
}

export async function createCustomWebhookIntegration(
  state: ControlPlaneState,
  input: CustomWebhookConfigInput,
): Promise<{ ok: true; integration: PublicCustomWebhookIntegration } | Failure> {
  const valid = validateInput(input, true);
  if (!valid.ok) return valid;
  if (!state.secretEncryptor) return unavailable();
  return withCustomWebhookReferenceFence(state, input, async (markers) => {
    const references = await validateConfiguredReferences(state, input);
    if (!references.ok) return references;
    const current = state.storage
      ? await state.storage.getCustomWebhookIntegration(input.id)
      : state.customWebhookIntegrations.get(input.id);
    if (current)
      return {
        ok: false as const,
        error: "custom webhook integration already exists",
        conflict: true as const,
      };
    const now = state.now();
    const record = await makeRecord(state, input, now, 1, now, randomUUID());
    if (
      state.storage &&
      !(await state.storage.putCustomWebhookIntegration(record, null, markers))
    ) {
      return conflict();
    }
    state.customWebhookIntegrations.set(input.id, record);
    return { ok: true, integration: toPublicCustomWebhookIntegration(record) };
  });
}

export async function updateCustomWebhookIntegration(
  state: ControlPlaneState,
  input: CustomWebhookConfigInput,
  expectedVersion?: number,
): Promise<{ ok: true; integration: PublicCustomWebhookIntegration } | Failure> {
  const valid = validateInput(input, false);
  if (!valid.ok) return valid;
  if (!state.secretEncryptor) return unavailable();
  return withCustomWebhookReferenceFence(state, input, async (markers) => {
    const references = await validateConfiguredReferences(state, input);
    if (!references.ok) return references;
    const current = state.storage
      ? await state.storage.getCustomWebhookIntegration(input.id)
      : state.customWebhookIntegrations.get(input.id);
    if (!current) return { ok: false, error: "custom webhook integration not found" };
    if (expectedVersion !== undefined && current.version !== expectedVersion) return conflict();
    const record = await makeRecord(
      state,
      input,
      current.createdAt,
      current.version + 1,
      state.now(),
      current.generation ?? randomUUID(),
      input.secret === undefined ? current.encryptedSecret : undefined,
    );
    if (
      state.storage &&
      !(await state.storage.putCustomWebhookIntegration(record, current.version, markers))
    ) {
      return conflict();
    }
    state.customWebhookIntegrations.set(input.id, record);
    return { ok: true, integration: toPublicCustomWebhookIntegration(record) };
  });
}

export async function deleteCustomWebhookIntegration(
  state: ControlPlaneState,
  id: string,
  expectedVersion?: number,
): Promise<{ ok: true } | Failure> {
  const current = state.storage
    ? await state.storage.getCustomWebhookIntegration(id)
    : state.customWebhookIntegrations.get(id);
  if (!current) return { ok: false, error: "custom webhook integration not found" };
  if (expectedVersion !== undefined && current.version !== expectedVersion) return conflict();
  if (state.storage && !(await state.storage.deleteCustomWebhookIntegration(id, current.version))) {
    return conflict();
  }
  state.customWebhookIntegrations.delete(id);
  return { ok: true };
}

export async function decryptCustomWebhookSecret(
  state: ControlPlaneState,
  id: string,
  record: CustomWebhookIntegrationRecord,
): Promise<string> {
  if (!state.secretEncryptor) throw new Error("custom webhook secret encryption is unavailable");
  const plaintext = await state.secretEncryptor.decrypt(
    record.encryptedSecret,
    customWebhookEncryptionContext(id),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("custom webhook secret ciphertext is invalid");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("secret" in parsed) ||
    typeof (parsed as { secret?: unknown }).secret !== "string"
  ) {
    throw new Error("custom webhook secret ciphertext is invalid");
  }
  return (parsed as { secret: string }).secret;
}

async function makeRecord(
  state: ControlPlaneState,
  input: CustomWebhookConfigInput,
  createdAt: string,
  version: number,
  updatedAt: string,
  generation: string,
  retainedEncryptedSecret?: string,
): Promise<CustomWebhookIntegrationRecord> {
  return {
    id: input.id,
    type: "custom-webhook",
    generation,
    encryptedSecret:
      retainedEncryptedSecret ??
      (await state.secretEncryptor!.encrypt(
        JSON.stringify({ secret: input.secret }),
        customWebhookEncryptionContext(input.id),
      )),
    repositoryId: input.repositoryId,
    target: input.target,
    fallbacks: input.fallbacks ?? [],
    queueTtlSeconds: input.queueTtlSeconds ?? DEFAULT_QUEUE_TTL_SECONDS,
    timeout: input.timeout,
    priority: input.priority ?? 0,
    requiredLabels: input.requiredLabels ?? [],
    enabled: input.enabled ?? true,
    version,
    createdAt,
    updatedAt,
  };
}

function validateInput(
  input: CustomWebhookConfigInput,
  requireSecret: boolean,
): { ok: true } | Failure {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)) {
    return {
      ok: false,
      error: "id must be 1-128 ASCII letters, numbers, dot, underscore, or hyphen",
    };
  }
  if (
    requireSecret &&
    (typeof input.secret !== "string" || input.secret.length < 16 || input.secret.length > 512)
  ) {
    return { ok: false, error: "secret must be between 16 and 512 characters" };
  }
  if (
    !requireSecret &&
    input.secret !== undefined &&
    (input.secret.length < 16 || input.secret.length > 512)
  ) {
    return { ok: false, error: "secret must be between 16 and 512 characters" };
  }
  if (typeof input.repositoryId !== "string" || !input.repositoryId) {
    return { ok: false, error: "repositoryId is required" };
  }
  const routing = validateTargetRouting({
    target: input.target,
    fallbacks: input.fallbacks,
    queueTtlSeconds: input.queueTtlSeconds,
  });
  if (!routing.ok) return routing;
  const timeout = sessionTimeoutError(input.timeout);
  if (timeout) return { ok: false, error: timeout };
  const priority = sessionPriorityError(input.priority ?? 0);
  if (priority) return { ok: false, error: priority };
  if (
    input.requiredLabels &&
    (!Array.isArray(input.requiredLabels) ||
      input.requiredLabels.some((v) => typeof v !== "string" || v.length === 0))
  ) {
    return { ok: false, error: "requiredLabels must be an array of non-empty strings" };
  }
  if (input.requiredLabels && input.requiredLabels.length > MAX_REQUIRED_LABELS) {
    return {
      ok: false,
      error: `requiredLabels must have at most ${MAX_REQUIRED_LABELS} entries`,
    };
  }
  if (input.requiredLabels?.some((label) => label.length > MAX_REQUIRED_LABEL_LENGTH)) {
    return {
      ok: false,
      error: `requiredLabels entries must be at most ${MAX_REQUIRED_LABEL_LENGTH} characters`,
    };
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  return { ok: true };
}

function unavailable(): Failure {
  return {
    ok: false,
    error: "custom webhook secret encryption is not configured",
    unavailable: true,
  };
}

async function validateConfiguredReferences(
  state: ControlPlaneState,
  input: CustomWebhookConfigInput,
): Promise<{ ok: true } | Failure> {
  return validateConfiguredTargetReferences(
    state,
    input.repositoryId,
    input.target,
    input.fallbacks,
  );
}

/** Validate operator-owned repository and target references before persisting an integration. */
export async function validateConfiguredTargetReferences(
  state: ControlPlaneState,
  repositoryId: string,
  target: CustomWebhookConfigInput["target"],
  fallbacks: CustomWebhookConfigInput["fallbacks"] = [],
): Promise<{ ok: true } | Failure> {
  const [repository, providers, commands] = state.storage
    ? await Promise.all([
        state.storage.getRepository(repositoryId),
        state.storage.listProviders(),
        state.storage.listCommands(),
      ])
    : [
        state.repositories.get(repositoryId) ?? null,
        [...state.providers.values()],
        [...state.commands.values()],
      ];
  if (!repository) return { ok: false, error: "repository not found" };
  const providerIds = new Set(providers.map((provider) => provider.id));
  const commandIds = new Set(commands.map((command) => command.id));
  for (const candidate of [target, ...(fallbacks ?? [])]) {
    if ("providerId" in candidate && !providerIds.has(candidate.providerId)) {
      return { ok: false, error: `providerId ${candidate.providerId} not found` };
    }
    if ("commandId" in candidate && !commandIds.has(candidate.commandId)) {
      return { ok: false, error: `commandId ${candidate.commandId} not found` };
    }
  }
  return { ok: true };
}

function conflict(): Failure {
  return {
    ok: false,
    error: "custom webhook integration changed concurrently; retry",
    conflict: true,
  };
}

/** Keep configuration and catalog deletes on the same durable ownership fences. */
async function withCustomWebhookReferenceFence<T extends { ok: boolean }>(
  state: ControlPlaneState,
  input: CustomWebhookConfigInput,
  operation: (
    markers:
      | readonly import("./db/plane-storage-deletion-markers.ts").OwnedDeletionMarker[]
      | undefined,
  ) => Promise<T>,
): Promise<T | Failure> {
  const keys = customWebhookReferenceKeys(input);
  return withDeletionMarkers(state, keys, async (owner) =>
    operation(owner ? keys.map((key) => ({ key, owner, now: state.now() })) : undefined),
  );
}

function customWebhookReferenceKeys(input: CustomWebhookConfigInput): string[] {
  const keys = new Set<string>([`repository:${input.repositoryId}`]);
  for (const route of [input.target, ...(input.fallbacks ?? [])]) {
    keys.add("providerId" in route ? `provider:${route.providerId}` : `command:${route.commandId}`);
  }
  return [...keys];
}

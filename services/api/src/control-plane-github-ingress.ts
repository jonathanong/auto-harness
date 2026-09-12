/* eslint-disable max-lines -- singleton ingress config validation and encrypted lifecycle are one boundary. */
import { randomUUID } from "node:crypto";

import {
  DEFAULT_QUEUE_TTL_SECONDS,
  isValidSessionRef,
  MAX_REQUIRED_LABELS,
  MAX_REQUIRED_LABEL_LENGTH,
  sessionPriorityError,
  sessionTimeoutError,
  validateTargetRouting,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import { validateSessionTargetCatalog } from "./control-plane-session-create.ts";
import {
  getRepositoryDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import {
  githubIngressEncryptionContext,
  toPublicGitHubIngressConfig,
  type GitHubIngressConfigInput,
  type PublicGitHubIngressConfig,
} from "./github-ingress-types.ts";
import type { GitHubIngressConfigRecord } from "./db/plane-storage-types.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";

type Failure = { ok: false; error: string; conflict?: true; unavailable?: true };

/** Leave headroom below DynamoDB's 400 KiB item limit for attribute overhead and evolution. */
export const MAX_GITHUB_INGRESS_CONFIG_BYTES = 300 * 1024;
/** One write plus at most 99 marker condition checks fits DynamoDB's 100-action limit. */
export const MAX_GITHUB_INGRESS_CATALOG_REFS = 99;

export async function getGitHubIngressConfig(
  state: ControlPlaneState,
): Promise<PublicGitHubIngressConfig | null> {
  const record = state.storage
    ? await state.storage.getGitHubIngressConfig()
    : state.githubIngressConfig;
  if (!record) return null;
  state.githubIngressConfig = record;
  return toPublicGitHubIngressConfig(record);
}

export async function getGitHubIngressConfigRecord(
  state: ControlPlaneState,
): Promise<GitHubIngressConfigRecord | null> {
  const record = state.storage
    ? await state.storage.getGitHubIngressConfig()
    : state.githubIngressConfig;
  if (record) state.githubIngressConfig = record;
  return record ?? null;
}

export async function createGitHubIngressConfig(
  state: ControlPlaneState,
  input: GitHubIngressConfigInput,
): Promise<{ ok: true; integration: PublicGitHubIngressConfig } | Failure> {
  const valid = validateInput(input, true);
  if (!valid.ok) return valid;
  if (!state.secretEncryptor) return unavailable();
  return withGitHubIngressReferenceFence(state, input, async (markers) => {
    const catalog = await validateConfiguredBindings(state, input);
    if (!catalog.ok) return catalog;
    const current = await getGitHubIngressConfigRecord(state);
    if (current)
      return {
        ok: false,
        error: "GitHub ingress integration already exists",
        conflict: true as const,
      };
    const now = state.now();
    const record = await makeRecord(state, input, randomUUID(), 1, now, now);
    const size = configSizeError(record);
    if (size) return { ok: false, error: size };
    if (!state.storage && state.githubIngressConfig) return conflict();
    if (state.storage && !(await state.storage.putGitHubIngressConfig(record, null, markers)))
      return conflict();
    state.githubIngressConfig = record;
    return { ok: true, integration: toPublicGitHubIngressConfig(record) };
  });
}

export async function updateGitHubIngressConfig(
  state: ControlPlaneState,
  input: GitHubIngressConfigInput,
  expectedVersion?: number,
  expectedGeneration?: string | null,
): Promise<{ ok: true; integration: PublicGitHubIngressConfig } | Failure> {
  const valid = validateInput(input, false);
  if (!valid.ok) return valid;
  if (!state.secretEncryptor) return unavailable();
  return withGitHubIngressReferenceFence(state, input, async (markers) => {
    const catalog = await validateConfiguredBindings(state, input);
    if (!catalog.ok) return catalog;
    const current = await getGitHubIngressConfigRecord(state);
    if (!current) return { ok: false, error: "GitHub ingress integration not found" };
    if (
      (expectedVersion !== undefined && current.version !== expectedVersion) ||
      (expectedGeneration === null
        ? current.generation !== undefined
        : expectedGeneration !== undefined && current.generation !== expectedGeneration)
    )
      return conflict();
    const record = await makeRecord(
      state,
      input,
      current.generation ?? randomUUID(),
      current.version + 1,
      current.createdAt,
      state.now(),
      input.secret === undefined ? current.encryptedSecret : undefined,
    );
    const size = configSizeError(record);
    if (size) return { ok: false, error: size };
    if (
      !state.storage &&
      (state.githubIngressConfig?.version !== current.version ||
        state.githubIngressConfig.generation !== current.generation)
    )
      return conflict();
    if (
      state.storage &&
      !(await state.storage.putGitHubIngressConfig(
        record,
        current.version,
        markers,
        current.generation ?? null,
      ))
    ) {
      return conflict();
    }
    state.githubIngressConfig = record;
    return { ok: true, integration: toPublicGitHubIngressConfig(record) };
  });
}

export async function deleteGitHubIngressConfig(
  state: ControlPlaneState,
  expectedVersion?: number,
  expectedGeneration?: string | null,
): Promise<{ ok: true } | Failure> {
  const current = await getGitHubIngressConfigRecord(state);
  if (!current) return { ok: false, error: "GitHub ingress integration not found" };
  if (
    (expectedVersion !== undefined && current.version !== expectedVersion) ||
    (expectedGeneration === null
      ? current.generation !== undefined
      : expectedGeneration !== undefined && current.generation !== expectedGeneration)
  )
    return conflict();
  if (
    state.storage &&
    !(await state.storage.deleteGitHubIngressConfig(current.version, current.generation ?? null))
  )
    return conflict();
  state.githubIngressConfig = undefined;
  return { ok: true };
}

export async function decryptGitHubIngressSecret(
  state: ControlPlaneState,
  record: GitHubIngressConfigRecord,
): Promise<string> {
  if (!state.secretEncryptor) throw new Error("GitHub ingress secret encryption is unavailable");
  const plaintext = await state.secretEncryptor.decrypt(
    record.encryptedSecret,
    githubIngressEncryptionContext(),
  );
  const parsed: unknown = JSON.parse(plaintext);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("secret" in parsed) ||
    typeof (parsed as { secret?: unknown }).secret !== "string"
  ) {
    throw new Error("GitHub ingress secret ciphertext is invalid");
  }
  return (parsed as { secret: string }).secret;
}

async function makeRecord(
  state: ControlPlaneState,
  input: GitHubIngressConfigInput,
  generation: string,
  version: number,
  createdAt: string,
  updatedAt: string,
  retainedEncryptedSecret?: string,
): Promise<GitHubIngressConfigRecord> {
  return {
    id: "github-ingress",
    type: "github-ingress",
    encryptedSecret:
      retainedEncryptedSecret ??
      (await state.secretEncryptor!.encrypt(
        JSON.stringify({ secret: input.secret }),
        githubIngressEncryptionContext(),
      )),
    enabled: input.enabled ?? true,
    generation,
    bindings: input.bindings.map((binding) => ({
      githubRepositoryId: binding.githubRepositoryId,
      repositoryId: binding.repositoryId,
      target: copyTarget(binding.target),
      fallbacks: (binding.fallbacks ?? []).map(copyTarget),
      queueTtlSeconds: binding.queueTtlSeconds ?? DEFAULT_QUEUE_TTL_SECONDS,
      timeout: binding.timeout,
      priority: binding.priority ?? 0,
      requiredLabels: binding.requiredLabels ?? [],
      defaultRef: binding.defaultRef,
      allowedLogins: binding.allowedLogins ?? [],
    })),
    version,
    createdAt,
    updatedAt,
  };
}

function copyTarget(target: { providerId: string } | { commandId: string }) {
  return "providerId" in target
    ? { providerId: target.providerId }
    : { commandId: target.commandId };
}

function validateInput(
  input: GitHubIngressConfigInput,
  requireSecret: boolean,
): { ok: true } | Failure {
  if (
    !Array.isArray(input.bindings) ||
    input.bindings.length === 0 ||
    input.bindings.length > 100
  ) {
    return { ok: false, error: "between 1 and 100 GitHub repository bindings are required" };
  }
  if (
    (requireSecret &&
      (typeof input.secret !== "string" ||
        input.secret.length < 16 ||
        input.secret.length > 512)) ||
    (!requireSecret &&
      input.secret !== undefined &&
      (input.secret.length < 16 || input.secret.length > 512))
  ) {
    return { ok: false, error: "secret must be between 16 and 512 characters" };
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  const ids = new Set<number>();
  for (const binding of input.bindings) {
    if (!Number.isSafeInteger(binding.githubRepositoryId) || binding.githubRepositoryId < 1) {
      return { ok: false, error: "githubRepositoryId must be a positive safe integer" };
    }
    if (ids.has(binding.githubRepositoryId)) {
      return { ok: false, error: "githubRepositoryId bindings must be unique" };
    }
    ids.add(binding.githubRepositoryId);
    if (
      typeof binding.repositoryId !== "string" ||
      binding.repositoryId.length === 0 ||
      binding.repositoryId.length > 256
    ) {
      return { ok: false, error: "repositoryId is required" };
    }
    if (!isValidSessionRef(binding.defaultRef)) {
      return { ok: false, error: "defaultRef must be a valid git ref" };
    }
    const routing = validateTargetRouting(binding);
    if (!routing.ok) return routing;
    const timeout = sessionTimeoutError(binding.timeout);
    if (timeout) return { ok: false, error: timeout };
    const priority = sessionPriorityError(binding.priority ?? 0);
    if (priority) return { ok: false, error: priority };
    if (
      binding.requiredLabels !== undefined &&
      (!Array.isArray(binding.requiredLabels) ||
        binding.requiredLabels.some((label) => typeof label !== "string"))
    ) {
      return { ok: false, error: "requiredLabels must be an array of strings" };
    }
    if (binding.requiredLabels && binding.requiredLabels.length > MAX_REQUIRED_LABELS) {
      return {
        ok: false,
        error: `requiredLabels must have at most ${MAX_REQUIRED_LABELS} entries`,
      };
    }
    if (binding.requiredLabels?.some((label) => label.length > MAX_REQUIRED_LABEL_LENGTH)) {
      return {
        ok: false,
        error: `requiredLabels entries must be at most ${MAX_REQUIRED_LABEL_LENGTH} characters`,
      };
    }
    if (
      binding.allowedLogins !== undefined &&
      (!Array.isArray(binding.allowedLogins) ||
        binding.allowedLogins.length > 100 ||
        binding.allowedLogins.some(
          (login) => typeof login !== "string" || login.length === 0 || login.length > 39,
        ))
    ) {
      return { ok: false, error: "allowedLogins must be non-empty strings" };
    }
  }
  if (githubIngressReferenceKeys(input).length > MAX_GITHUB_INGRESS_CATALOG_REFS) {
    return {
      ok: false,
      error: `GitHub ingress configuration may reference at most ${MAX_GITHUB_INGRESS_CATALOG_REFS} unique catalog entries`,
    };
  }
  return { ok: true };
}

function unavailable(): Failure {
  return {
    ok: false,
    error: "GitHub ingress secret encryption is not configured",
    unavailable: true,
  };
}

function conflict(): Failure {
  return {
    ok: false,
    error: "GitHub ingress integration changed concurrently; retry",
    conflict: true,
  };
}

async function validateConfiguredBindings(
  state: ControlPlaneState,
  input: GitHubIngressConfigInput,
): Promise<{ ok: true } | Failure> {
  if (state.storage) await refreshTargetCatalogDurable(state);
  for (const binding of input.bindings) {
    const repository = await getRepositoryDurable(state, binding.repositoryId);
    if (!repository) return { ok: false, error: "repository not found" };
    const candidate = validateSessionTargetCatalog(state, binding.target, binding.fallbacks ?? []);
    if (!candidate.ok) return { ok: false, error: candidate.error };
  }
  return { ok: true };
}

/** Keep configuration writes alive only while all referenced catalog rows are undeleted. */
async function withGitHubIngressReferenceFence<T extends { ok: boolean }>(
  state: ControlPlaneState,
  input: GitHubIngressConfigInput,
  operation: (
    markers:
      | readonly import("./db/plane-storage-deletion-markers.ts").OwnedDeletionMarker[]
      | undefined,
  ) => Promise<T>,
): Promise<T | Failure> {
  const keys = githubIngressReferenceKeys(input);
  return withDeletionMarkers(state, keys, async (owner) =>
    operation(owner ? keys.map((key) => ({ key, owner, now: state.now() })) : undefined),
  );
}

function githubIngressReferenceKeys(input: GitHubIngressConfigInput): string[] {
  const keys = new Set<string>();
  for (const binding of input.bindings) {
    keys.add(`repository:${binding.repositoryId}`);
    for (const route of [binding.target, ...(binding.fallbacks ?? [])]) {
      keys.add(
        "providerId" in route ? `provider:${route.providerId}` : `command:${route.commandId}`,
      );
    }
  }
  return [...keys];
}

function configSizeError(record: GitHubIngressConfigRecord): string | null {
  const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
  return bytes > MAX_GITHUB_INGRESS_CONFIG_BYTES
    ? `GitHub ingress configuration must be at most ${MAX_GITHUB_INGRESS_CONFIG_BYTES} bytes`
    : null;
}

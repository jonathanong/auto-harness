import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
  MAX_CONCURRENT_SESSIONS_LIMIT,
} from "@auto-harness/shared";

import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

type ProviderAccountInput = {
  id?: string;
  providerId: string;
  label: string;
  usageLimitCooldownSeconds?: number;
  maxConcurrentSessions?: number;
};

type ProviderAccountPatch = Partial<{
  providerId: string;
  label: string;
  usageLimitCooldownSeconds: number;
  maxConcurrentSessions: number;
}>;

export function prepareCreateProviderAccount(
  state: ControlPlaneState,
  input: ProviderAccountInput,
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  if (!input.providerId || !input.label) {
    return { ok: false, error: "providerId and label are required" };
  }
  if (!state.providers.has(input.providerId)) {
    return { ok: false, error: `unknown provider: ${input.providerId}` };
  }
  if (
    input.usageLimitCooldownSeconds !== undefined &&
    (!Number.isInteger(input.usageLimitCooldownSeconds) || input.usageLimitCooldownSeconds <= 0)
  ) {
    return { ok: false, error: "usageLimitCooldownSeconds must be a positive integer" };
  }
  if (
    input.maxConcurrentSessions !== undefined &&
    (!Number.isInteger(input.maxConcurrentSessions) ||
      input.maxConcurrentSessions < 1 ||
      input.maxConcurrentSessions > MAX_CONCURRENT_SESSIONS_LIMIT)
  ) {
    return {
      ok: false,
      error: `maxConcurrentSessions must be an integer between 1 and ${String(MAX_CONCURRENT_SESSIONS_LIMIT)}`,
    };
  }
  const id = input.id ?? state.providerAccountIdFactory();
  if (state.providerAccounts.has(id)) {
    return { ok: false, error: `provider account already exists: ${id}` };
  }
  const at = state.now();
  return {
    ok: true,
    account: {
      id,
      providerId: input.providerId,
      label: input.label,
      usageLimitCooldownSeconds:
        input.usageLimitCooldownSeconds ?? DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
      maxConcurrentSessions: input.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
    },
  };
}

export function prepareUpdateProviderAccount(
  state: ControlPlaneState,
  id: string,
  patch: ProviderAccountPatch,
):
  | {
      ok: true;
      existing: ProviderAccountRecord;
      account: ProviderAccountRecord;
      patch: Partial<
        Pick<
          ProviderAccountRecord,
          "providerId" | "label" | "usageLimitCooldownSeconds" | "maxConcurrentSessions"
        >
      >;
    }
  | { ok: false; error: string } {
  const existing = state.providerAccounts.get(id);
  if (!existing) return { ok: false, error: "provider account not found" };
  if (patch.providerId !== undefined && !state.providers.has(patch.providerId)) {
    return { ok: false, error: `unknown provider: ${patch.providerId}` };
  }
  if (
    patch.usageLimitCooldownSeconds !== undefined &&
    (!Number.isInteger(patch.usageLimitCooldownSeconds) || patch.usageLimitCooldownSeconds <= 0)
  ) {
    return { ok: false, error: "usageLimitCooldownSeconds must be a positive integer" };
  }
  if (
    patch.maxConcurrentSessions !== undefined &&
    (!Number.isInteger(patch.maxConcurrentSessions) ||
      patch.maxConcurrentSessions < 1 ||
      patch.maxConcurrentSessions > MAX_CONCURRENT_SESSIONS_LIMIT)
  ) {
    return {
      ok: false,
      error: `maxConcurrentSessions must be an integer between 1 and ${String(MAX_CONCURRENT_SESSIONS_LIMIT)}`,
    };
  }
  if (
    patch.maxConcurrentSessions !== undefined &&
    patch.maxConcurrentSessions <
      (existing.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS)
  ) {
    for (const lease of state.providerAccountLeases.values()) {
      if (lease.providerAccountId === id && lease.slot >= patch.maxConcurrentSessions) {
        return {
          ok: false,
          error: "cannot reduce maxConcurrentSessions while an active lease uses a removed slot",
        };
      }
    }
  }
  const account: ProviderAccountRecord = {
    ...existing,
    updatedAt: state.now(),
    version: (existing.version ?? 0) + 1,
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.usageLimitCooldownSeconds !== undefined
      ? { usageLimitCooldownSeconds: patch.usageLimitCooldownSeconds }
      : {}),
    ...(patch.maxConcurrentSessions !== undefined
      ? { maxConcurrentSessions: patch.maxConcurrentSessions }
      : {}),
  };
  return {
    ok: true,
    existing,
    account,
    patch: {
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.usageLimitCooldownSeconds !== undefined
        ? { usageLimitCooldownSeconds: patch.usageLimitCooldownSeconds }
        : {}),
      ...(patch.maxConcurrentSessions !== undefined
        ? { maxConcurrentSessions: patch.maxConcurrentSessions }
        : {}),
    },
  };
}

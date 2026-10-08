import {
  normalizeControlPlaneSessionLogSettings,
  publicControlPlaneSessionLogSettings,
  SESSION_LOG_SETTINGS_ID,
  type ControlPlaneSessionLogSettings,
  type PublicControlPlaneSessionLogSettings,
  type SessionLogSettings,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionLogSettingsRecord } from "./db/plane-storage-types.ts";

export function assignLogSettings(state: ControlPlaneState): SessionLogSettings {
  const settings = normalizeControlPlaneSessionLogSettings(state.sessionLogSettings);
  return {
    uploadMode: settings.uploadMode,
    batchMaxKb: settings.batchMaxKb,
    batchMaxLines: settings.batchMaxLines,
    batchMaxWaitMs: settings.batchMaxWaitMs,
    controlPlanePollMs: settings.controlPlanePollMs,
  };
}

export async function getSessionLogSettings(
  state: ControlPlaneState,
): Promise<PublicControlPlaneSessionLogSettings> {
  const record =
    state.storage && typeof state.storage.getSessionLogSettings === "function"
      ? await state.storage.getSessionLogSettings()
      : state.sessionLogSettings;
  if (record) state.sessionLogSettings = record;
  return publicControlPlaneSessionLogSettings(record ?? undefined);
}

export async function putSessionLogSettings(
  state: ControlPlaneState,
  input: Partial<ControlPlaneSessionLogSettings> & { version: number },
): Promise<
  | { ok: true; settings: PublicControlPlaneSessionLogSettings }
  | { ok: false; error: string; conflict?: true }
> {
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    return { ok: false, error: "version must contain the observed non-negative integer version" };
  }
  const current =
    state.storage && typeof state.storage.getSessionLogSettings === "function"
      ? await state.storage.getSessionLogSettings()
      : state.sessionLogSettings;
  let settings: ControlPlaneSessionLogSettings;
  try {
    settings = normalizeControlPlaneSessionLogSettings({
      ...current,
      ...input,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid session log settings",
    };
  }
  if ((current?.version ?? 0) !== input.version) {
    return { ok: false, error: "version conflict", conflict: true };
  }
  const now = state.now();
  const record: SessionLogSettingsRecord = {
    id: SESSION_LOG_SETTINGS_ID,
    type: SESSION_LOG_SETTINGS_ID,
    ...settings,
    version: (current?.version ?? 0) + 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  };
  if (state.storage && typeof state.storage.putSessionLogSettings === "function") {
    const written = await state.storage.putSessionLogSettings(
      record,
      current ? current.version : null,
    );
    if (!written) return { ok: false, error: "version conflict", conflict: true };
  }
  state.sessionLogSettings = record;
  return { ok: true, settings: publicControlPlaneSessionLogSettings(record) };
}

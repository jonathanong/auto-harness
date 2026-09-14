import {
  normalizeSessionLogSettings,
  publicSessionLogSettings,
  SESSION_LOG_SETTINGS_ID,
  type PublicSessionLogSettings,
  type SessionLogSettings,
} from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionLogSettingsRecord } from "./db/plane-storage-types.ts";

export function assignLogSettings(state: ControlPlaneState): SessionLogSettings {
  return normalizeSessionLogSettings(state.sessionLogSettings);
}

export async function getSessionLogSettings(
  state: ControlPlaneState,
): Promise<PublicSessionLogSettings> {
  const record =
    state.storage && typeof state.storage.getSessionLogSettings === "function"
      ? await state.storage.getSessionLogSettings()
      : state.sessionLogSettings;
  if (record) state.sessionLogSettings = record;
  return publicSessionLogSettings(record ?? undefined);
}

export async function putSessionLogSettings(
  state: ControlPlaneState,
  input: Partial<SessionLogSettings> & { version: number },
): Promise<
  { ok: true; settings: PublicSessionLogSettings } | { ok: false; error: string; conflict?: true }
> {
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    return { ok: false, error: "version must contain the observed non-negative integer version" };
  }
  const settings = normalizeSessionLogSettings(input);
  const current =
    state.storage && typeof state.storage.getSessionLogSettings === "function"
      ? await state.storage.getSessionLogSettings()
      : state.sessionLogSettings;
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
  return { ok: true, settings: publicSessionLogSettings(record) };
}

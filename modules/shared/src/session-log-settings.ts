/** Operator-controlled session log upload and control-plane poll. */

export const SESSION_LOG_UPLOAD_MODES = ["off", "subscribed", "always"] as const;

export type SessionLogUploadMode = (typeof SESSION_LOG_UPLOAD_MODES)[number];

export type SessionLogSettings = {
  /** Default `off`: autonomous runs do not write log bodies to S3. */
  uploadMode: SessionLogUploadMode;
  /** Uncompressed JSONL bytes that flush a gzip part. */
  batchMaxKb: number;
  /** JSONL lines that flush a gzip part. */
  batchMaxLines: number;
  /** Flush pending output at least this often. */
  batchMaxWaitMs: number;
  /** Control-plane UI REST poll while the session is non-terminal. */
  controlPlanePollMs: number;
};

export const DEFAULT_SESSION_LOG_SETTINGS: SessionLogSettings = {
  uploadMode: "off",
  batchMaxKb: 256,
  batchMaxLines: 500,
  batchMaxWaitMs: 60_000,
  controlPlanePollMs: 60_000,
};

const SESSION_LOG_POLL_MS_MIN = 5_000;
const SESSION_LOG_POLL_MS_MAX = 5 * 60_000;
const SESSION_LOG_BATCH_MAX_KB_MIN = 1;
const SESSION_LOG_BATCH_MAX_KB_MAX = 5 * 1024;
const SESSION_LOG_BATCH_MAX_LINES_MIN = 1;
const SESSION_LOG_BATCH_MAX_LINES_MAX = 50_000;
const SESSION_LOG_BATCH_MAX_WAIT_MS_MIN = 1_000;
const SESSION_LOG_BATCH_MAX_WAIT_MS_MAX = 5 * 60_000;

export function isSessionLogUploadMode(value: unknown): value is SessionLogUploadMode {
  return (
    typeof value === "string" && (SESSION_LOG_UPLOAD_MODES as readonly string[]).includes(value)
  );
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeSessionLogSettings(
  over: Partial<SessionLogSettings> | undefined,
): SessionLogSettings {
  const uploadMode = isSessionLogUploadMode(over?.uploadMode)
    ? over.uploadMode
    : DEFAULT_SESSION_LOG_SETTINGS.uploadMode;
  return {
    uploadMode,
    batchMaxKb: clampInt(
      over?.batchMaxKb ?? DEFAULT_SESSION_LOG_SETTINGS.batchMaxKb,
      SESSION_LOG_BATCH_MAX_KB_MIN,
      SESSION_LOG_BATCH_MAX_KB_MAX,
    ),
    batchMaxLines: clampInt(
      over?.batchMaxLines ?? DEFAULT_SESSION_LOG_SETTINGS.batchMaxLines,
      SESSION_LOG_BATCH_MAX_LINES_MIN,
      SESSION_LOG_BATCH_MAX_LINES_MAX,
    ),
    batchMaxWaitMs: clampInt(
      over?.batchMaxWaitMs ?? DEFAULT_SESSION_LOG_SETTINGS.batchMaxWaitMs,
      SESSION_LOG_BATCH_MAX_WAIT_MS_MIN,
      SESSION_LOG_BATCH_MAX_WAIT_MS_MAX,
    ),
    controlPlanePollMs: clampInt(
      over?.controlPlanePollMs ?? DEFAULT_SESSION_LOG_SETTINGS.controlPlanePollMs,
      SESSION_LOG_POLL_MS_MIN,
      SESSION_LOG_POLL_MS_MAX,
    ),
  };
}

export function sessionLogPartKey(sessionId: string, seqStart: number, seqEnd: number): string {
  return `sessions/${sessionId}/parts/${seqStart}-${seqEnd}.jsonl.gz`;
}

export function sessionLogArchiveKey(sessionId: string): string {
  return `sessions/${sessionId}/logs.jsonl.gz`;
}

const PART_KEY = /^sessions\/[^/]+\/parts\/\d+-\d+\.jsonl\.gz$/;
const ARCHIVE_KEY = /^sessions\/[^/]+\/logs\.jsonl\.gz$/;

export function isSessionLogObjectKey(key: string): boolean {
  return PART_KEY.test(key) || ARCHIVE_KEY.test(key);
}

export const SESSION_LOG_SETTINGS_ID = "session-log-settings" as const;

export type PublicSessionLogSettings = SessionLogSettings & { version: number };

export function publicSessionLogSettings(
  over?: Partial<SessionLogSettings> & { version?: number },
): PublicSessionLogSettings {
  const version = over?.version;
  return {
    ...normalizeSessionLogSettings(over),
    version:
      typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0,
  };
}

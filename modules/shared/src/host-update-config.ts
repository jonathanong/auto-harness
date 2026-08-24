const MAX_UPDATE_PUBLIC_KEY_LENGTH = 32 * 1024;
const MAX_UPDATE_URL_LENGTH = 2048;
const MAX_UPDATE_PATH_LENGTH = 4096;
const MAX_UPDATE_POLL_MS = 2_147_483_647;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Control-plane-owned signed-update settings for one host daemon. When absent,
 * the daemon retains its service-environment fallback. An explicit disabled
 * value overrides that fallback without requiring host-file edits.
 */
export type HostUpdateConfig = {
  enabled: boolean;
  manifestUrl?: string;
  publicKey?: string;
  installDir?: string;
  pollMs?: number;
  daemonVersion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLength) {
    throw new TypeError(`updateConfig.${key} must be a non-empty string within its limit`);
  }
  return raw;
}

function requireHttpsUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("updateConfig.manifestUrl must be an HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("updateConfig.manifestUrl must be an HTTPS URL without credentials");
  }
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Strictly parse host-daemon signed-update configuration stored in inventory. */
export function parseHostUpdateConfig(value: unknown): HostUpdateConfig {
  if (!isRecord(value) || typeof value.enabled !== "boolean") {
    throw new TypeError("updateConfig.enabled must be a boolean");
  }
  const permitted = new Set([
    "enabled",
    "manifestUrl",
    "publicKey",
    "installDir",
    "pollMs",
    "daemonVersion",
  ]);
  if (Object.keys(value).some((key) => !permitted.has(key))) {
    throw new TypeError("updateConfig contains an unsupported field");
  }
  if (!value.enabled) {
    if (Object.keys(value).length !== 1) {
      throw new TypeError("disabled updateConfig cannot include update settings");
    }
    return { enabled: false };
  }

  const manifestUrl = optionalString(value, "manifestUrl", MAX_UPDATE_URL_LENGTH);
  const publicKey = optionalString(value, "publicKey", MAX_UPDATE_PUBLIC_KEY_LENGTH);
  if (!manifestUrl || !publicKey) {
    throw new TypeError("enabled updateConfig requires manifestUrl and publicKey");
  }
  requireHttpsUrl(manifestUrl);
  const installDir = optionalString(value, "installDir", MAX_UPDATE_PATH_LENGTH);
  if (installDir !== undefined && !isAbsolutePath(installDir)) {
    throw new TypeError("updateConfig.installDir must be an absolute path");
  }
  let pollMs: number | undefined;
  if (value.pollMs !== undefined) {
    if (
      typeof value.pollMs !== "number" ||
      !Number.isInteger(value.pollMs) ||
      value.pollMs < 0 ||
      value.pollMs > MAX_UPDATE_POLL_MS
    ) {
      throw new TypeError(`updateConfig.pollMs must be an integer from 0 to ${MAX_UPDATE_POLL_MS}`);
    }
    pollMs = value.pollMs;
  }
  const daemonVersion = optionalString(value, "daemonVersion", 64);
  if (daemonVersion !== undefined && !VERSION_PATTERN.test(daemonVersion)) {
    throw new TypeError("updateConfig.daemonVersion must be a semantic version");
  }
  return {
    enabled: true,
    manifestUrl,
    publicKey,
    ...(installDir !== undefined ? { installDir } : {}),
    ...(pollMs !== undefined ? { pollMs } : {}),
    ...(daemonVersion !== undefined ? { daemonVersion } : {}),
  };
}

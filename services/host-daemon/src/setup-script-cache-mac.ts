import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Process-lifetime key; never written to the checkout, DynamoDB, or child env. */
let macKey: Buffer | undefined;

function setupCacheMacKey(): Buffer {
  macKey ??= randomBytes(32);
  return macKey;
}

export type SetupCacheMacPayload = {
  worktreeId: string;
  cwd: string;
  fingerprint: string;
  environment: Record<string, string | undefined>;
};

function payloadMac(payload: SetupCacheMacPayload): Buffer {
  const hmac = createHmac("sha256", setupCacheMacKey());
  hmac.update("v1\0");
  hmac.update(payload.worktreeId);
  hmac.update("\0");
  hmac.update(payload.cwd);
  hmac.update("\0");
  hmac.update(payload.fingerprint);
  const keys = Object.keys(payload.environment).toSorted();
  hmac.update("\0");
  hmac.update(String(keys.length));
  for (const key of keys) {
    hmac.update("\0");
    hmac.update(key);
    hmac.update("\0");
    hmac.update(payload.environment[key] ?? "");
  }
  return hmac.digest();
}

/** Sidecar names are unguessable without the daemon MAC key. */
export function setupCacheFileName(worktreeId: string, cwd: string): string {
  return createHmac("sha256", setupCacheMacKey())
    .update("name\0")
    .update(worktreeId)
    .update("\0")
    .update(cwd)
    .digest("hex");
}

export function signSetupCachePayload(payload: SetupCacheMacPayload): string {
  return payloadMac(payload).toString("hex");
}

export function verifySetupCachePayload(payload: SetupCacheMacPayload & { mac: unknown }): boolean {
  if (typeof payload.mac !== "string") return false;
  const actual = Buffer.from(payload.mac, "hex");
  const expected = payloadMac(payload);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

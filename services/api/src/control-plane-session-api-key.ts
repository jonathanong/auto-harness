import { createHash, randomBytes } from "node:crypto";

export function createSessionApiKey(): { key: string; hash: string } {
  const key = `hns_session_${randomBytes(32).toString("base64url")}`;
  return { key, hash: createHash("sha256").update(key).digest("hex") };
}

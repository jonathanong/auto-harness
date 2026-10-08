import { createHash } from "node:crypto";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
const ARTIFACT_KEY =
  /^sessions\/([A-Za-z0-9_-]{1,256})\/artifacts\/[a-f0-9]{64}-[a-f0-9]{64}\.tar\.gz$/;

/** The exact key is server-derived from the immutable session and attempt. */
export function sessionArtifactKey(sessionId: string, attemptId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("invalid session artifact id");
  const safeId = createHash("sha256").update(sessionId).digest("hex");
  const safeAttempt = createHash("sha256").update(attemptId).digest("hex");
  return `sessions/${sessionId}/artifacts/${safeId}-${safeAttempt}.tar.gz`;
}

export function isSessionArtifactKey(key: string, sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId) && ARTIFACT_KEY.exec(key)?.[1] === sessionId;
}

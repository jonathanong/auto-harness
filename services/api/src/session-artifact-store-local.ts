import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
  SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS,
  type SessionArtifactUpload,
} from "@auto-harness/shared";
import {
  CONTENT_TYPE,
  DOWNLOAD_TTL_SECONDS,
  type ArtifactObject,
  type SessionArtifactStore,
} from "./session-artifact-store.ts";

/** Local mode stores the exact gzip stream on disk; files survive API restart. */
export class LocalSessionArtifactStore implements SessionArtifactStore {
  private readonly signingKey = randomBytes(32);
  readonly directory: string;
  constructor(directory = join(homedir(), ".auto-harness", "session-artifacts")) {
    this.directory = directory;
  }

  private sign(sessionId: string, attemptId: string, version: string, expires: number): string {
    return createHmac("sha256", this.signingKey)
      .update(`${sessionId}\0${attemptId}\0${version}\0${expires}`)
      .digest("hex");
  }

  verify(
    sessionId: string,
    attemptId: string,
    version: string,
    expiresText: string | null,
    token: string | null,
  ): boolean {
    const expires = Number(expiresText);
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      return false;
    return timingSafeEqual(
      Buffer.from(token, "hex"),
      Buffer.from(this.sign(sessionId, attemptId, version, expires), "hex"),
    );
  }

  private path(sessionId: string, attemptId: string): string {
    return join(
      this.directory,
      createHash("sha256").update(`${sessionId}\0${attemptId}`).digest("hex") + ".tar.gz",
    );
  }

  async upload(
    sessionId: string,
    attemptId: string,
    _size: number,
    sha256: string,
    now: string,
    baseUrl: string,
    authorization?: string,
  ): Promise<SessionArtifactUpload> {
    const expires = Date.now() + SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS * 1000;
    const token = this.sign(sessionId, attemptId, sha256, expires);
    const url = `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/outputs/upload/${encodeURIComponent(attemptId)}?expires=${expires}&token=${token}`;
    return {
      method: "PUT",
      url,
      headers: {
        "content-type": CONTENT_TYPE,
        "x-auto-harness-sha256": sha256,
        ...(authorization ? { authorization } : {}),
      },
      expiresAt: new Date(expires).toISOString(),
    };
  }

  async put(
    req: IncomingMessage,
    sessionId: string,
    attemptId: string,
    expected: { size: number; sha256: string },
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(sessionId, attemptId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const digest = createHash("sha256");
    let size = 0;
    const tally = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > expected.size) return callback(new Error("artifact length exceeds manifest"));
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, tally, createWriteStream(temp, { mode: 0o600 }), {
        signal: AbortSignal.timeout(SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS),
      });
      if (size !== expected.size || digest.digest("hex") !== expected.sha256)
        throw new Error("artifact integrity mismatch");
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async inspect(sessionId: string, attemptId: string): Promise<ArtifactObject | null> {
    const path = this.path(sessionId, attemptId);
    try {
      const file = await stat(path);
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      const sha256 = digest.digest("hex");
      return { versionId: sha256, size: file.size, sha256, contentType: CONTENT_TYPE };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async downloadUrl(
    sessionId: string,
    attemptId: string,
    versionId: string,
    baseUrl: string,
    nowMs: number,
  ): Promise<string> {
    const expires = nowMs + DOWNLOAD_TTL_SECONDS * 1000;
    const token = this.sign(sessionId, attemptId, versionId, expires);
    return `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/download/${encodeURIComponent(attemptId)}?version=${encodeURIComponent(versionId)}&expires=${expires}&token=${token}`;
  }

  async stream(res: ServerResponse, sessionId: string, attemptId: string): Promise<void> {
    res.setHeader("Content-Type", CONTENT_TYPE);
    res.setHeader("Content-Disposition", 'attachment; filename="artifacts.tar.gz"');
    res.setHeader("Cache-Control", "no-store");
    await pipeline(createReadStream(this.path(sessionId, attemptId)), res);
  }

  async deleteSession(sessionId: string, attemptId: string): Promise<void> {
    await unlink(this.path(sessionId, attemptId)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  }
}

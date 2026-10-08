import type { PrepareSessionOutputsRequest } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  createSessionOutputManifest,
  requirePublishable,
  SessionOutputStoreError,
} from "./db/plane-storage-session-outputs-core.ts";
import type {
  SessionOutputManifest,
  SessionOutputPayload,
} from "./db/plane-storage-session-outputs-types.ts";

/** Storage-less tests/local mode; production uses the Dynamo exact-key store. */
export class MemorySessionOutputsStore {
  private readonly manifests = new Map<string, SessionOutputManifest>();
  private readonly payloads = new Map<string, SessionOutputPayload>();

  private readonly state: ControlPlaneState;
  constructor(state: ControlPlaneState) {
    this.state = state;
  }

  async getSession(sessionId: string) {
    return this.state.sessions.get(sessionId) ?? null;
  }
  async getManifest(sessionId: string) {
    return this.manifests.get(sessionId) ?? null;
  }
  async getPayload(sessionId: string) {
    return this.payloads.get(sessionId) ?? null;
  }

  async prepare(
    sessionId: string,
    request: PrepareSessionOutputsRequest,
    hostId: string,
    now: string,
  ): Promise<SessionOutputManifest> {
    const session = requirePublishable(
      await this.getSession(sessionId),
      request.attemptId,
      hostId,
      now,
    );
    const manifest = createSessionOutputManifest(sessionId, request, now);
    const existing = this.manifests.get(sessionId);
    if (existing) {
      if (
        existing.attemptId !== request.attemptId ||
        existing.fingerprint !== manifest.fingerprint
      ) {
        throw new SessionOutputStoreError(
          "OUTPUT_CONFLICT",
          409,
          "session output manifest already exists",
        );
      }
      if (existing.artifactsState === "pending") {
        session.outputsUploadExpiresAt = new Date(Date.parse(now) + 370_000).toISOString();
      }
      return existing;
    }
    if (manifest.artifactsState === "pending") {
      session.outputsUploadExpiresAt = new Date(Date.parse(now) + 370_000).toISOString();
    }
    this.manifests.set(sessionId, manifest);
    if (request.output.state === "ready") {
      this.payloads.set(sessionId, {
        sessionId,
        recordKey: "payload",
        attemptId: request.attemptId,
        jsonText: request.output.jsonText,
        sha256: request.output.sha256,
      });
    }
    return manifest;
  }

  async complete(
    sessionId: string,
    attemptId: string,
    hostId: string,
    now: string,
    artifact?: { key: string; versionId: string },
  ): Promise<SessionOutputManifest> {
    requirePublishable(await this.getSession(sessionId), attemptId, hostId, now);
    const manifest = this.manifests.get(sessionId);
    if (!manifest || manifest.attemptId !== attemptId)
      throw new SessionOutputStoreError(
        "OUTPUTS_NOT_PREPARED",
        409,
        "session outputs are not prepared",
      );
    if (manifest.completedAt) return manifest;
    if (manifest.artifactsState === "pending" && !artifact)
      throw new SessionOutputStoreError(
        "OUTPUTS_NOT_UPLOADED",
        409,
        "artifact upload is not verified",
      );
    const ready: SessionOutputManifest = {
      ...manifest,
      completedAt: now,
      ...(artifact
        ? { artifactsState: "ready", objectKey: artifact.key, objectVersionId: artifact.versionId }
        : {}),
    };
    this.manifests.set(sessionId, ready);
    return ready;
  }
}

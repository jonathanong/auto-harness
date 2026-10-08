/* eslint-disable max-lines -- four related session-output routes share one exact-key service. */
import {
  SESSION_OUTPUT_RETRY_WINDOW_MS,
  type PrepareSessionOutputsRequest,
} from "@auto-harness/shared";

import { mayAccessHost, mayAccessRepository } from "./auth-policy.ts";
import type { DynamoSessionOutputsStore } from "./db/plane-storage-session-outputs.ts";
import {
  requirePublishable,
  SessionOutputStoreError,
} from "./db/plane-storage-session-outputs-core.ts";
import type { MemorySessionOutputsStore } from "./session-outputs-memory-store.ts";
import { LocalSessionArtifactStore, type SessionArtifactStore } from "./session-artifact-store.ts";
import { sessionArtifactKey } from "./session-artifact-key.ts";
import { parsePrepareSessionOutputs } from "./session-outputs-validate.ts";
import { readRawBody, send, sendInternalError, type RouteCtx } from "./local-http.ts";

type OutputStore = DynamoSessionOutputsStore | MemorySessionOutputsStore;
const error = (code: string, message: string) => ({ error: { code, message } });
const expired = {
  state: "error",
  error: { code: "OUTPUTS_UNAVAILABLE", message: "session outputs were not reported" },
};

function canRead(
  ctx: RouteCtx,
  session: { repositoryId: string; hostId?: string | null; resolvedRoute?: { hostId: string } },
): boolean {
  return (
    mayAccessRepository(ctx.principal, session.repositoryId) &&
    mayAccessHost(ctx.principal, session.hostId ?? session.resolvedRoute?.hostId)
  );
}

function publicationHost(
  ctx: RouteCtx,
  session: { resolvedRoute?: { hostId: string } },
): string | undefined {
  // Bound daemon keys may publish only their original assignment. In local
  // disabled-auth mode there is no principal; the exact session fence still applies.
  if (ctx.principal && !ctx.principal.boundHostId) return undefined;
  return ctx.principal?.boundHostId ?? session.resolvedRoute?.hostId;
}

function pendingOrExpired(completedAt: string | undefined, now: string) {
  return completedAt && Date.parse(now) > Date.parse(completedAt) + SESSION_OUTPUT_RETRY_WINDOW_MS
    ? expired
    : { state: "pending" as const };
}

function rawReadyOutput(ctx: RouteCtx, jsonText: string, capturedAt: string): void {
  // Preserve every valid JSON value, including null, huge numeric literals and
  // deeply nested documents, without a lossy parse/serialize round-trip.
  const payload = `{"state":"ready","output":${jsonText},"capturedAt":${JSON.stringify(capturedAt)}}`;
  ctx.res.setHeader("Content-Type", "application/json");
  ctx.res.setHeader("Content-Length", Buffer.byteLength(payload));
  ctx.res.writeHead(200);
  ctx.res.end(payload);
}

async function readBody(ctx: RouteCtx): Promise<unknown> {
  const body = await readRawBody(ctx.req, 2 * 1024 * 1024);
  return JSON.parse(body.toString("utf8")) as unknown;
}

async function outputRead(
  ctx: RouteCtx,
  store: OutputStore,
  sessionId: string,
  kind: "output" | "artifacts",
  artifactStore: SessionArtifactStore,
  baseUrl: string,
): Promise<void> {
  ctx.res.setHeader("Cache-Control", "no-store");
  const session = await store.getSession(sessionId);
  if (!session || session.retentionToken || !canRead(ctx, session))
    return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  if (!session.sessionOutputsSupported) return send(ctx.res, 200, { state: "unsupported" });
  const now = ctx.plane.state.now();
  const manifest = await store.getManifest(sessionId);
  if (session.terminalHookHandoff || !manifest)
    return send(ctx.res, 200, pendingOrExpired(session.completedAt, now));
  if (kind === "output") {
    if (manifest.outputState === "none") return send(ctx.res, 200, { state: "none" });
    if (manifest.outputState === "error")
      return send(ctx.res, 200, { state: "error", error: manifest.outputError });
    const payload = await store.getPayload(sessionId);
    if (!payload || payload.attemptId !== manifest.attemptId)
      throw new Error("session output payload missing");
    return rawReadyOutput(ctx, payload.jsonText, manifest.capturedAt);
  }
  if (manifest.artifactsState === "none") return send(ctx.res, 200, { state: "none" });
  if (manifest.artifactsState === "error")
    return send(ctx.res, 200, { state: "error", error: manifest.artifactsError });
  if (
    manifest.artifactsState !== "ready" ||
    !manifest.objectVersionId ||
    !manifest.sha256 ||
    !manifest.compressedBytes
  ) {
    return send(ctx.res, 200, pendingOrExpired(session.completedAt, now));
  }
  const urlNow = Date.now();
  const downloadUrl = await artifactStore.downloadUrl(
    sessionId,
    manifest.attemptId,
    manifest.objectVersionId,
    baseUrl,
    urlNow,
  );
  return send(ctx.res, 200, {
    state: "ready",
    downloadUrl,
    expiresAt: new Date(urlNow + 300_000).toISOString(),
    capturedAt: manifest.capturedAt,
    contentType: "application/gzip",
    filename: "artifacts.tar.gz",
    compressedBytes: manifest.compressedBytes,
    sha256: manifest.sha256,
  });
}

async function prepare(
  ctx: RouteCtx,
  store: OutputStore,
  artifactStore: SessionArtifactStore,
  sessionId: string,
  baseUrl: string,
): Promise<void> {
  let request: PrepareSessionOutputsRequest | null;
  try {
    request = parsePrepareSessionOutputs(await readBody(ctx));
  } catch {
    request = null;
  }
  if (!request)
    return send(ctx.res, 400, error("VALIDATION_ERROR", "invalid session output submission"));
  const session = await store.getSession(sessionId);
  if (!session || !canRead(ctx, session))
    return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  const hostId = publicationHost(ctx, session);
  if (!hostId) return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  const now = ctx.plane.state.now();
  const manifest = await store.prepare(sessionId, request, hostId, now);
  if (manifest.artifactsState !== "pending" || !manifest.sha256 || !manifest.compressedBytes)
    return send(ctx.res, 200, {});
  const authorization =
    typeof ctx.req.headers.authorization === "string" ? ctx.req.headers.authorization : undefined;
  const artifactUpload = await artifactStore.upload(
    sessionId,
    request.attemptId,
    manifest.compressedBytes,
    manifest.sha256,
    now,
    baseUrl,
    authorization,
  );
  // Signing may resolve fresh AWS credentials. Extend the upload hold from the
  // time the URL is ready, and fence retention again before exposing it.
  await store.prepare(sessionId, request, hostId, ctx.plane.state.now());
  return send(ctx.res, 200, { artifactUpload });
}

async function complete(
  ctx: RouteCtx,
  store: OutputStore,
  artifactStore: SessionArtifactStore,
  sessionId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(ctx);
  } catch {
    return send(ctx.res, 400, error("VALIDATION_ERROR", "invalid completion"));
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof (body as { attemptId?: unknown }).attemptId !== "string"
  ) {
    return send(ctx.res, 400, error("VALIDATION_ERROR", "invalid completion"));
  }
  const attemptId = (body as { attemptId: string }).attemptId;
  const session = await store.getSession(sessionId);
  if (!session || !canRead(ctx, session))
    return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  const hostId = publicationHost(ctx, session);
  if (!hostId) return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  const manifest = await store.getManifest(sessionId);
  let artifact: { key: string; versionId: string } | undefined;
  if (manifest?.artifactsState === "pending") {
    const object = await artifactStore.inspect(sessionId, attemptId);
    if (
      !object ||
      object.size !== manifest.compressedBytes ||
      object.sha256 !== manifest.sha256 ||
      object.contentType !== "application/gzip"
    ) {
      throw new SessionOutputStoreError(
        "OUTPUTS_NOT_UPLOADED",
        409,
        "artifact upload is not verified",
      );
    }
    artifact = { key: sessionArtifactKey(sessionId, attemptId), versionId: object.versionId };
  }
  await store.complete(sessionId, attemptId, hostId, ctx.plane.state.now(), artifact);
  return send(ctx.res, 200, {});
}

async function localUpload(
  ctx: RouteCtx,
  store: OutputStore,
  artifactStore: LocalSessionArtifactStore,
  sessionId: string,
  attemptId: string,
): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session || !canRead(ctx, session))
    return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  const hostId = publicationHost(ctx, session);
  if (!hostId) return send(ctx.res, 404, error("NOT_FOUND", "session not found"));
  requirePublishable(session, attemptId, hostId, ctx.plane.state.now());
  const manifest = await store.getManifest(sessionId);
  if (
    !manifest ||
    manifest.attemptId !== attemptId ||
    manifest.artifactsState !== "pending" ||
    !manifest.sha256 ||
    !manifest.compressedBytes
  ) {
    return send(ctx.res, 409, error("OUTPUTS_NOT_PREPARED", "artifact upload is not prepared"));
  }
  if (
    !artifactStore.verify(
      sessionId,
      attemptId,
      manifest.sha256,
      ctx.url.searchParams.get("expires"),
      ctx.url.searchParams.get("token"),
    )
  ) {
    return send(
      ctx.res,
      403,
      error("UPLOAD_URL_EXPIRED", "artifact upload URL is invalid or expired"),
    );
  }
  if (
    ctx.req.headers["content-type"] !== "application/gzip" ||
    ctx.req.headers["x-auto-harness-sha256"] !== manifest.sha256
  ) {
    return send(ctx.res, 400, error("VALIDATION_ERROR", "artifact headers do not match manifest"));
  }
  try {
    await artifactStore.put(ctx.req, sessionId, attemptId, {
      size: manifest.compressedBytes,
      sha256: manifest.sha256,
    });
  } catch {
    return send(ctx.res, 400, error("ARTIFACT_INTEGRITY", "artifact length or checksum mismatch"));
  }
  return send(ctx.res, 200, {});
}

/** A short-lived local signed download is authorized like an S3 presigned URL. */
export async function handleLocalArtifactDownload(
  ctx: RouteCtx,
  store: OutputStore,
  artifactStore: SessionArtifactStore,
): Promise<boolean> {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/artifacts\/download\/([^/]+)$/.exec(
    ctx.url.pathname,
  );
  if (ctx.method !== "GET" || !match || !(artifactStore instanceof LocalSessionArtifactStore))
    return false;
  ctx.res.setHeader("Cache-Control", "no-store");
  const sessionId = decodeURIComponent(match[1]!);
  const attemptId = decodeURIComponent(match[2]!);
  const version = ctx.url.searchParams.get("version") ?? "";
  if (
    !artifactStore.verify(
      sessionId,
      attemptId,
      version,
      ctx.url.searchParams.get("expires"),
      ctx.url.searchParams.get("token"),
    )
  ) {
    send(ctx.res, 404, error("NOT_FOUND", "artifact not found"));
    return true;
  }
  const session = await store.getSession(sessionId);
  const manifest = await store.getManifest(sessionId);
  if (
    !session ||
    session.retentionToken ||
    !manifest ||
    manifest.artifactsState !== "ready" ||
    manifest.attemptId !== attemptId ||
    manifest.objectVersionId !== version
  ) {
    send(ctx.res, 404, error("NOT_FOUND", "artifact not found"));
    return true;
  }
  const object = await artifactStore.inspect(sessionId, attemptId);
  if (
    !object ||
    object.versionId !== version ||
    object.sha256 !== manifest.sha256 ||
    object.size !== manifest.compressedBytes ||
    object.contentType !== "application/gzip"
  ) {
    send(ctx.res, 404, error("NOT_FOUND", "artifact not found"));
    return true;
  }
  await artifactStore.stream(ctx.res, sessionId, attemptId);
  return true;
}

export async function handleSessionOutputRoutes(
  ctx: RouteCtx,
  store: OutputStore,
  artifactStore: SessionArtifactStore,
  baseUrl: string,
): Promise<boolean> {
  const readMatch = /^\/api\/v1\/sessions\/([^/]+)\/(output|artifacts)$/.exec(ctx.url.pathname);
  const mutateMatch = /^\/api\/v1\/sessions\/([^/]+)\/outputs\/(prepare|complete)$/.exec(
    ctx.url.pathname,
  );
  const uploadMatch = /^\/api\/v1\/sessions\/([^/]+)\/outputs\/upload\/([^/]+)$/.exec(
    ctx.url.pathname,
  );
  if (!readMatch && !mutateMatch && !uploadMatch) return false;
  ctx.res.setHeader("Cache-Control", "no-store");
  try {
    if (ctx.method === "GET" && readMatch)
      await outputRead(
        ctx,
        store,
        decodeURIComponent(readMatch[1]!),
        readMatch[2] as "output" | "artifacts",
        artifactStore,
        baseUrl,
      );
    else if (ctx.method === "POST" && mutateMatch?.[2] === "prepare")
      await prepare(ctx, store, artifactStore, decodeURIComponent(mutateMatch[1]!), baseUrl);
    else if (ctx.method === "POST" && mutateMatch?.[2] === "complete")
      await complete(ctx, store, artifactStore, decodeURIComponent(mutateMatch[1]!));
    else if (
      ctx.method === "PUT" &&
      uploadMatch &&
      artifactStore instanceof LocalSessionArtifactStore
    )
      await localUpload(
        ctx,
        store,
        artifactStore,
        decodeURIComponent(uploadMatch[1]!),
        decodeURIComponent(uploadMatch[2]!),
      );
    else return false;
  } catch (cause) {
    if (cause instanceof SessionOutputStoreError)
      send(ctx.res, cause.status, error(cause.code, cause.message));
    else sendInternalError(ctx.res, { error: cause, method: ctx.method, url: ctx.url });
  }
  return true;
}

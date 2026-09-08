/* eslint-disable max-lines -- v1/v2 cursor validation intentionally shares signing primitives. */
import {
  concurrencyIdByteLengthError,
  isSessionSource,
  isSessionStatus,
  type SessionSource,
  type SessionStatus,
} from "@auto-harness/shared";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { ControlPlaneState } from "./control-plane-state.ts";

export type SessionListSort = "latest" | "oldest" | "priority_desc" | "priority_asc";

export type SessionListScope = {
  /** Repository allow-list from the authenticated principal. */
  repositoryIds?: readonly string[] | undefined;
  /** Host binding from the authenticated principal. */
  hostId?: string | undefined;
};

export type ListSessionsPageQuery = {
  /** Page size (default 50, max 100). */
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
  repositoryId?: string;
  status?: string;
  hostId?: string;
  sort?: SessionListSort;
  concurrencyId?: string;
  scheduleId?: string;
  source?: string;
  scope?: SessionListScope | undefined;
};

export type CursorPosition = { createdAt: string; id: string; priority: number };
export type CursorQuery = {
  repositoryId: string | null;
  status: SessionStatus | null;
  hostId: string | null;
  concurrencyId: string | null;
  scheduleId: string | null;
  source: SessionSource | null;
};
export type CursorScope = { repositoryIds: string[] | null; hostId: string | null };
export type SessionCursor = {
  version: 1;
  sort: SessionListSort;
  query: CursorQuery;
  scope: CursorScope;
  position: CursorPosition;
};

/** A typed DynamoDB `ExclusiveStartKey` retained independently for each list partition. */
export type SessionPartitionCheckpoint = Record<string, string>;
export type SessionCursorV2 = {
  version: 2;
  sort: SessionListSort;
  query: CursorQuery;
  /**
   * A keyed digest of the request scope. Keeping the allow-list out of the
   * continuation prevents large principals from producing unusable URLs.
   */
  scopeHash: string;
  /** Logical emitted bound, also retained while a v1 cursor is being upgraded. */
  position?: CursorPosition;
  partitions: Array<{
    id: string;
    checkpoint: SessionPartitionCheckpoint | null;
    exhausted: boolean;
  }>;
};
export type AnySessionCursor = SessionCursor | SessionCursorV2;

export class InvalidSessionCursorError extends Error {
  constructor() {
    super("invalid or mismatched session cursor");
    this.name = "InvalidSessionCursorError";
  }
}

export class InvalidSessionListQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSessionListQueryError";
  }
}

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidSessionListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

export function normalizeSort(sort: SessionListSort | undefined): SessionListSort {
  if (sort === undefined || sort === "latest") return "latest";
  if (sort === "oldest" || sort === "priority_desc" || sort === "priority_asc") return sort;
  throw new InvalidSessionListQueryError("invalid sort");
}

function normalizeFilter(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  if (value.length === 0) throw new InvalidSessionListQueryError(`${name} must not be empty`);
  return value;
}

export function normalizeQuery(query: ListSessionsPageQuery): CursorQuery {
  const status = normalizeFilter(query.status, "status");
  if (status !== null && status !== "all" && !isSessionStatus(status)) {
    throw new InvalidSessionListQueryError("status must be all or a recognized session status");
  }
  const source = normalizeFilter(query.source, "source");
  if (source !== null && !isSessionSource(source)) {
    throw new InvalidSessionListQueryError("source must be a recognized session source");
  }
  const concurrencyId = normalizeFilter(query.concurrencyId, "concurrencyId");
  if (concurrencyId !== null) {
    const concurrencyIdBytes = concurrencyIdByteLengthError(concurrencyId);
    if (concurrencyIdBytes) throw new InvalidSessionListQueryError(concurrencyIdBytes);
  }
  return {
    repositoryId: normalizeFilter(query.repositoryId, "repositoryId"),
    status: status === null || status === "all" ? null : status,
    hostId: normalizeFilter(query.hostId, "hostId"),
    concurrencyId,
    scheduleId: normalizeFilter(query.scheduleId, "scheduleId"),
    source,
  };
}

export function normalizeScope(scope: SessionListScope | undefined): CursorScope {
  const repositoryIds = scope?.repositoryIds;
  return {
    repositoryIds: repositoryIds === undefined ? null : [...new Set(repositoryIds)].toSorted(),
    hostId: scope?.hostId ?? null,
  };
}

function cursorPayload(cursor: AnySessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function sign(state: ControlPlaneState, payload: string): string {
  return createHmac("sha256", state.sessionCursorSecret).update(payload).digest("base64url");
}

const v2CursorPrefix = "v2";
const v2CursorAad = "auto-harness/session-cursor/v2";

function v2EncryptionKey(state: ControlPlaneState): Buffer {
  return createHash("sha256")
    .update("auto-harness/session-cursor/v2/encryption\\0")
    .update(state.sessionCursorSecret)
    .digest();
}

/** A stable, non-reversible scope binding for compact durable cursors. */
export function sessionCursorScopeHash(state: ControlPlaneState, scope: CursorScope): string {
  return createHmac("sha256", state.sessionCursorSecret)
    .update("auto-harness/session-cursor/v2/scope\\0")
    .update(JSON.stringify(scope))
    .digest("base64url");
}

function encryptV2Cursor(state: ControlPlaneState, cursor: SessionCursorV2): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", v2EncryptionKey(state), iv);
  cipher.setAAD(Buffer.from(v2CursorAad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cursor), "utf8"), cipher.final()]);
  return [
    v2CursorPrefix,
    iv.toString("base64url"),
    encrypted.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function decryptV2Cursor(state: ControlPlaneState, encoded: string): unknown {
  const [, encodedIv, encrypted, encodedTag, ...extra] = encoded.split(".");
  if (!encodedIv || !encrypted || !encodedTag || extra.length > 0) {
    throw new InvalidSessionCursorError();
  }
  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const ciphertext = Buffer.from(encrypted, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new InvalidSessionCursorError();
    }
    const decipher = createDecipheriv("aes-256-gcm", v2EncryptionKey(state), iv);
    decipher.setAAD(Buffer.from(v2CursorAad, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    ) as unknown;
  } catch (error) {
    if (error instanceof InvalidSessionCursorError) throw error;
    throw new InvalidSessionCursorError();
  }
}

function decodeSignedCursorPayload(state: ControlPlaneState, encoded: string): unknown {
  const parts = encoded.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidSessionCursorError();
  const expectedSignature = sign(state, parts[0]);
  const actualSignature = Buffer.from(parts[1]!, "base64url");
  const expectedSignatureBytes = Buffer.from(expectedSignature, "base64url");
  if (
    actualSignature.length !== expectedSignatureBytes.length ||
    !timingSafeEqual(actualSignature, expectedSignatureBytes)
  ) {
    throw new InvalidSessionCursorError();
  }
  try {
    return JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidSessionCursorError();
  }
}

function normalizeCursorQuery(query: unknown): unknown {
  if (!query || typeof query !== "object" || Array.isArray(query)) return query;
  const cursorQuery = query as Partial<CursorQuery>;
  return { ...cursorQuery, source: cursorQuery.source ?? null };
}

export function encodeSessionCursor(state: ControlPlaneState, cursor: AnySessionCursor): string {
  if (cursor && typeof cursor === "object" && cursor.version === 2) {
    return encryptV2Cursor(state, cursor);
  }
  const payload = cursorPayload(cursor);
  return `${payload}.${sign(state, payload)}`;
}

export function decodeSessionCursor(
  state: ControlPlaneState,
  encoded: string,
  expected: Omit<SessionCursor, "position">,
): CursorPosition {
  const decoded = decodeSignedCursorPayload(state, encoded);
  if (!decoded || typeof decoded !== "object") throw new InvalidSessionCursorError();
  const cursor = decoded as Partial<SessionCursor>;
  if (
    cursor.version !== expected.version ||
    cursor.sort !== expected.sort ||
    JSON.stringify(normalizeCursorQuery(cursor.query)) !== JSON.stringify(expected.query) ||
    JSON.stringify(cursor.scope) !== JSON.stringify(expected.scope)
  ) {
    throw new InvalidSessionCursorError();
  }
  const position = cursor.position;
  if (
    !position ||
    typeof position !== "object" ||
    typeof position.createdAt !== "string" ||
    typeof position.id !== "string" ||
    typeof position.priority !== "number" ||
    !Number.isFinite(position.priority)
  ) {
    throw new InvalidSessionCursorError();
  }
  return position;
}

/** Decode a durable cursor. V1 remains supported so old links upgrade on their next response. */
export function decodeDurableSessionCursor(
  state: ControlPlaneState,
  encoded: string,
  expected: Omit<SessionCursor, "position" | "version">,
): AnySessionCursor {
  const decoded = encoded.startsWith(`${v2CursorPrefix}.`)
    ? decryptV2Cursor(state, encoded)
    : decodeSignedCursorPayload(state, encoded);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new InvalidSessionCursorError();
  }
  const cursor = decoded as Partial<AnySessionCursor>;
  if (
    (cursor.version !== 1 && cursor.version !== 2) ||
    cursor.sort !== expected.sort ||
    JSON.stringify(normalizeCursorQuery(cursor.query)) !== JSON.stringify(expected.query)
  ) {
    throw new InvalidSessionCursorError();
  }
  if (cursor.version === 1) {
    if (JSON.stringify(cursor.scope) !== JSON.stringify(expected.scope)) {
      throw new InvalidSessionCursorError();
    }
    const position = cursor.position;
    if (
      !position ||
      typeof position !== "object" ||
      typeof position.createdAt !== "string" ||
      typeof position.id !== "string" ||
      typeof position.priority !== "number" ||
      !Number.isFinite(position.priority)
    ) {
      throw new InvalidSessionCursorError();
    }
    return cursor as SessionCursor;
  }
  const durableCursor = cursor as Partial<SessionCursorV2>;
  const expectedScopeHash = Buffer.from(sessionCursorScopeHash(state, expected.scope), "base64url");
  const cursorScopeHash =
    typeof durableCursor.scopeHash === "string"
      ? Buffer.from(durableCursor.scopeHash, "base64url")
      : undefined;
  if (
    !cursorScopeHash ||
    cursorScopeHash.length !== expectedScopeHash.length ||
    cursorScopeHash.toString("base64url") !== durableCursor.scopeHash ||
    !timingSafeEqual(cursorScopeHash, expectedScopeHash)
  ) {
    throw new InvalidSessionCursorError();
  }
  if (durableCursor.position !== undefined && !validPosition(durableCursor.position)) {
    throw new InvalidSessionCursorError();
  }
  if (!Array.isArray(durableCursor.partitions)) throw new InvalidSessionCursorError();
  const seen = new Set<string>();
  for (const partition of durableCursor.partitions) {
    if (!partition || typeof partition !== "object" || Array.isArray(partition)) {
      throw new InvalidSessionCursorError();
    }
    if (
      typeof partition.id !== "string" ||
      partition.id.length === 0 ||
      seen.has(partition.id) ||
      typeof partition.exhausted !== "boolean" ||
      (partition.checkpoint !== null &&
        (!partition.checkpoint ||
          typeof partition.checkpoint !== "object" ||
          Array.isArray(partition.checkpoint) ||
          Object.values(partition.checkpoint).some((value) => typeof value !== "string")))
    ) {
      throw new InvalidSessionCursorError();
    }
    seen.add(partition.id);
  }
  return durableCursor as SessionCursorV2;
}

function validPosition(position: unknown): position is CursorPosition {
  return (
    !!position &&
    typeof position === "object" &&
    typeof (position as CursorPosition).createdAt === "string" &&
    typeof (position as CursorPosition).id === "string" &&
    typeof (position as CursorPosition).priority === "number" &&
    Number.isFinite((position as CursorPosition).priority)
  );
}

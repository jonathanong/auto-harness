import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { ControlPlaneState } from "./control-plane-state.ts";

export type RepositoryListScope = {
  /** Repository allow-list from the authenticated principal. */
  repositoryIds?: readonly string[] | undefined;
};

export type ListRepositoriesPageQuery = {
  /** Page size (default 50, max 100). */
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
  scope?: RepositoryListScope | undefined;
};

/**
 * The cursor stores a digest rather than the complete allow-list. This keeps
 * cursors bounded even when a principal can see a large number of repositories.
 */
export type RepositoryCursorScope = { repositoryIdsDigest: string | null };
export type RepositoryCursorPosition = { name: string; id: string };
export type RepositoryCursor = {
  version: 1;
  domain: "repositories";
  scope: RepositoryCursorScope;
  position?: RepositoryCursorPosition;
  storageKey?: Record<string, unknown>;
};

export class InvalidRepositoryCursorError extends Error {
  constructor() {
    super("invalid or mismatched repository cursor");
    this.name = "InvalidRepositoryCursorError";
  }
}

export class InvalidRepositoryListQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepositoryListQueryError";
  }
}

export function normalizeRepositoryLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidRepositoryListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

export function normalizeRepositoryScope(
  scope: RepositoryListScope | undefined,
): RepositoryCursorScope {
  const repositoryIds = normalizeRepositoryIds(scope);
  return {
    repositoryIdsDigest:
      repositoryIds === null
        ? null
        : createHash("sha256").update(JSON.stringify(repositoryIds)).digest("base64url"),
  };
}

/** Normalize the scope for filtering while its digest is used in cursors. */
export function normalizeRepositoryIds(scope: RepositoryListScope | undefined): string[] | null {
  const repositoryIds = scope?.repositoryIds;
  return repositoryIds === undefined
    ? null
    : [...new Set(repositoryIds)].toSorted((left, right) => left.localeCompare(right));
}

function cursorPayload(cursor: RepositoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Keep a repository cursor from ever validating as another cursor domain. */
function sign(state: ControlPlaneState, payload: string): string {
  return createHmac("sha256", state.sessionCursorSecret)
    .update(`repositories\0${payload}`)
    .digest("base64url");
}

export function encodeRepositoryCursor(state: ControlPlaneState, cursor: RepositoryCursor): string {
  const payload = cursorPayload(cursor);
  return `${payload}.${sign(state, payload)}`;
}

export function decodeRepositoryCursor(
  state: ControlPlaneState,
  encoded: string,
  expected: Omit<RepositoryCursor, "position">,
): Pick<RepositoryCursor, "position" | "storageKey"> {
  const parts = encoded.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidRepositoryCursorError();
  const actualSignature = Buffer.from(parts[1]!, "base64url");
  const expectedSignature = Buffer.from(sign(state, parts[0]!), "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new InvalidRepositoryCursorError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidRepositoryCursorError();
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new InvalidRepositoryCursorError();
  }
  const cursor = decoded as Partial<RepositoryCursor>;
  if (
    cursor.version !== expected.version ||
    cursor.domain !== "repositories" ||
    JSON.stringify(cursor.scope) !== JSON.stringify(expected.scope)
  ) {
    throw new InvalidRepositoryCursorError();
  }
  const position = cursor.position;
  const storageKey = cursor.storageKey;
  if (
    (position === undefined) === (storageKey === undefined) ||
    (position !== undefined &&
      (typeof position !== "object" ||
        Array.isArray(position) ||
        typeof position.name !== "string" ||
        typeof position.id !== "string")) ||
    (storageKey !== undefined &&
      (typeof storageKey !== "object" || storageKey === null || Array.isArray(storageKey)))
  ) {
    throw new InvalidRepositoryCursorError();
  }
  return {
    ...(position === undefined ? {} : { position }),
    ...(storageKey === undefined ? {} : { storageKey }),
  };
}

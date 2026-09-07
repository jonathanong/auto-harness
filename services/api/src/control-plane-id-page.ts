import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_ID_PAGE_LIMIT = 50;
const MAX_ID_PAGE_LIMIT = 100;

export class InvalidListPageQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidListPageQueryError";
  }
}

export type ListPageQuery = { limit: number; cursor: string | null };

export type ListPage<T> = { items: T[]; nextCursor: string | null };

/** Parse `limit` (1–100, default 50) and a single opaque `cursor`. */
export function parseListPageQuery(url: URL): ListPageQuery {
  return {
    limit: parseLimit(readSingleQueryParam(url, "limit")),
    cursor: readSingleQueryParam(url, "cursor") ?? null,
  };
}

export function readSingleQueryParam(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new InvalidListPageQueryError(`${name} must appear only once`);
  const value = values[0];
  if (value === "") throw new InvalidListPageQueryError(`${name} must not be empty`);
  return value;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ID_PAGE_LIMIT;
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidListPageQueryError("limit must be a base-10 integer between 1 and 100");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ID_PAGE_LIMIT) {
    throw new InvalidListPageQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

/**
 * Stable id-ordered page. Visibility/filtering must already have been applied.
 * `cursor` is the last key from the previous page; the next page starts strictly after it.
 */
export function pageByKey<T>(
  items: readonly T[],
  options: {
    limit: number;
    cursor: string | null;
    key: (item: T) => string;
    compare?: (left: T, right: T) => number;
  },
): ListPage<T> {
  const compare =
    options.compare ?? ((left: T, right: T) => options.key(left).localeCompare(options.key(right)));
  const rows = [...items].toSorted(compare);
  const remaining = options.cursor
    ? rows.filter((item) => options.key(item).localeCompare(options.cursor!) > 0)
    : rows;
  const page = remaining.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: remaining.length > options.limit && last ? options.key(last) : null,
  };
}

const STORAGE_CURSOR_PREFIX = "s1.";

export type StorageCursorScope = { hostId: string | null; repositoryId: string | null };

const emptyStorageScope: StorageCursorScope = { hostId: null, repositoryId: null };

function storageCursorSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(`storage\0${payload}`).digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "base64url");
  const right = Buffer.from(expected, "base64url");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** HMAC-opaque ExclusiveStartKey cursor. The client cannot decode the Dynamo key. */
export function encodeStorageCursor(
  key: Record<string, unknown> | null,
  secret: string,
  scope: StorageCursorScope = emptyStorageScope,
): string | null {
  if (!key) return null;
  const payload = Buffer.from(
    JSON.stringify({ key, hostId: scope.hostId, repositoryId: scope.repositoryId }),
    "utf8",
  ).toString("base64url");
  return `${STORAGE_CURSOR_PREFIX}${payload}.${storageCursorSignature(secret, payload)}`;
}

export function decodeStorageCursor(
  cursor: string | null,
  secret: string,
  scope: StorageCursorScope = emptyStorageScope,
): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  if (!cursor.startsWith(STORAGE_CURSOR_PREFIX)) {
    throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  }
  const rest = cursor.slice(STORAGE_CURSOR_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  const payload = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  if (!signaturesMatch(signature, storageCursorSignature(secret, payload))) {
    throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    const body = decoded as {
      key?: unknown;
      hostId?: string | null;
      repositoryId?: string | null;
    };
    if (!body.key || typeof body.key !== "object" || Array.isArray(body.key)) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    if (body.hostId !== scope.hostId || body.repositoryId !== scope.repositoryId) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    return body.key as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidListPageQueryError) throw error;
    throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  }
}

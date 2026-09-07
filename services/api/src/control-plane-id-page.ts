import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

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

export type StorageCursorScope = {
  hostId: string | null;
  repositoryId: string | null;
  kind?: string | null;
};

const emptyStorageScope: StorageCursorScope = { hostId: null, repositoryId: null };

function storageCursorKind(scope: StorageCursorScope): string | null {
  return scope.kind ?? null;
}
const STORAGE_CURSOR_IV_LENGTH = 12;
const STORAGE_CURSOR_TAG_LENGTH = 16;

function storageCursorKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encryptStorageCursor(plaintext: string, secret: string): string {
  const iv = randomBytes(STORAGE_CURSOR_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", storageCursorKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `${STORAGE_CURSOR_PREFIX}${packed.toString("base64url")}`;
}

function decryptStorageCursor(cursor: string, secret: string): string {
  const packed = Buffer.from(cursor.slice(STORAGE_CURSOR_PREFIX.length), "base64url");
  if (packed.length <= STORAGE_CURSOR_IV_LENGTH + STORAGE_CURSOR_TAG_LENGTH) {
    throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  }
  const iv = packed.subarray(0, STORAGE_CURSOR_IV_LENGTH);
  const tag = packed.subarray(
    STORAGE_CURSOR_IV_LENGTH,
    STORAGE_CURSOR_IV_LENGTH + STORAGE_CURSOR_TAG_LENGTH,
  );
  const ciphertext = packed.subarray(STORAGE_CURSOR_IV_LENGTH + STORAGE_CURSOR_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", storageCursorKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Authenticated-encrypted ExclusiveStartKey cursor. The client cannot read the Dynamo key. */
export function encodeStorageCursor(
  key: Record<string, unknown> | null,
  secret: string,
  scope: StorageCursorScope = emptyStorageScope,
): string | null {
  if (!key) return null;
  return encryptStorageCursor(
    JSON.stringify({
      key,
      hostId: scope.hostId,
      repositoryId: scope.repositoryId,
      kind: storageCursorKind(scope),
    }),
    secret,
  );
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
  try {
    const decoded: unknown = JSON.parse(decryptStorageCursor(cursor, secret));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    const body = decoded as {
      key?: unknown;
      hostId?: string | null;
      repositoryId?: string | null;
      kind?: string | null;
    };
    if (!body.key || typeof body.key !== "object" || Array.isArray(body.key)) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    if (
      body.hostId !== scope.hostId ||
      body.repositoryId !== scope.repositoryId ||
      (body.kind ?? null) !== storageCursorKind(scope)
    ) {
      throw new InvalidListPageQueryError("invalid or mismatched list cursor");
    }
    return body.key as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidListPageQueryError) throw error;
    throw new InvalidListPageQueryError("invalid or mismatched list cursor");
  }
}

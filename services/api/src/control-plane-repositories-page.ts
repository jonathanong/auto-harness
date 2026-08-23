import { createHmac, timingSafeEqual } from "node:crypto";

import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { listRepositories } from "./control-plane-repos.ts";

export type ListRepositoriesPageQuery = {
  /** Page size (default 50, max 100). */
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
  /** Repository visibility scope from the authenticated principal. */
  scope?: readonly string[] | undefined;
};

export type ListRepositoriesPageResult = {
  items: RepositoryRecord[];
  nextCursor: string | null;
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

type CursorScope = string[] | null;
type RepositoryCursor = {
  version: 1;
  scope: CursorScope;
  position: { name: string; id: string };
};

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidRepositoryListQueryError("limit must be a base-10 integer between 1 and 100");
  }
  return limit;
}

function normalizeScope(scope: readonly string[] | undefined): CursorScope {
  return scope === undefined
    ? null
    : [...new Set(scope)].toSorted((left, right) => left.localeCompare(right));
}

function compareRepositories(a: RepositoryRecord, b: RepositoryRecord): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function payload(cursor: RepositoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function sign(state: ControlPlaneState, value: string): string {
  return createHmac("sha256", state.sessionCursorSecret).update(value).digest("base64url");
}

function encodeCursor(state: ControlPlaneState, cursor: RepositoryCursor): string {
  const value = payload(cursor);
  return `${value}.${sign(state, value)}`;
}

function decodeCursor(
  state: ControlPlaneState,
  encoded: string,
  scope: CursorScope,
): RepositoryCursor["position"] {
  const parts = encoded.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidRepositoryCursorError();
  const expected = sign(state, parts[0]);
  const actualBytes = Buffer.from(parts[1], "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new InvalidRepositoryCursorError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new InvalidRepositoryCursorError();
  }
  if (!decoded || typeof decoded !== "object") throw new InvalidRepositoryCursorError();
  const cursor = decoded as Partial<RepositoryCursor>;
  if (
    cursor.version !== 1 ||
    JSON.stringify(cursor.scope) !== JSON.stringify(scope) ||
    !cursor.position ||
    typeof cursor.position !== "object" ||
    typeof cursor.position.name !== "string" ||
    typeof cursor.position.id !== "string"
  ) {
    throw new InvalidRepositoryCursorError();
  }
  return cursor.position;
}

/** Scope and all visibility filtering are applied before slicing. */
export function listRepositoriesPage(
  state: ControlPlaneState,
  query: ListRepositoriesPageQuery = {},
  records: readonly RepositoryRecord[] = listRepositories(state),
): ListRepositoriesPageResult {
  const limit = normalizeLimit(query.limit);
  const scope = normalizeScope(query.scope);
  const position = query.cursor ? decodeCursor(state, query.cursor, scope) : undefined;
  let rows = records
    .filter((repository) => scope === null || scope.includes(repository.id))
    .toSorted(compareRepositories);
  if (position) {
    rows = rows.filter(
      (repository) =>
        compareRepositories(repository, { ...repository, name: position.name, id: position.id }) >
        0,
    );
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((repository) => ({ ...repository })),
    nextCursor:
      rows.length > page.length && last
        ? encodeCursor(state, { version: 1, scope, position: { name: last.name, id: last.id } })
        : null,
  };
}

import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  normalizeRepositoryIds,
  normalizeRepositoryLimit,
  normalizeRepositoryScope,
} from "./control-plane-repository-cursor.ts";
import { compareRepositories, listRepositories } from "./control-plane-repos.ts";
import { listRepositoriesDurable } from "./control-plane-durable-read-catalog.ts";

export {
  InvalidRepositoryCursorError,
  InvalidRepositoryListQueryError,
  type ListRepositoriesPageQuery,
} from "./control-plane-repository-cursor.ts";
import type { ListRepositoriesPageQuery } from "./control-plane-repository-cursor.ts";

export type ListRepositoriesPageResult = {
  items: RepositoryRecord[];
  nextCursor: string | null;
};

type ParsedRepositoryPageQuery = {
  cursorBase: {
    version: 1;
    domain: "repositories";
    scope: ReturnType<typeof normalizeRepositoryScope>;
  };
  limit: number;
  position: { name: string; id: string } | undefined;
  repositoryIds: string[] | null;
};

function parseRepositoryPageQuery(
  state: ControlPlaneState,
  query: ListRepositoriesPageQuery,
): ParsedRepositoryPageQuery {
  const limit = normalizeRepositoryLimit(query.limit);
  const repositoryIds = normalizeRepositoryIds(query.scope);
  const scope = normalizeRepositoryScope(query.scope);
  const cursorBase = { version: 1 as const, domain: "repositories" as const, scope };
  return {
    cursorBase,
    limit,
    position: query.cursor ? decodeRepositoryCursor(state, query.cursor, cursorBase) : undefined,
    repositoryIds,
  };
}

function pageResult(
  state: ControlPlaneState,
  parsed: ParsedRepositoryPageQuery,
  items: readonly RepositoryRecord[],
  hasMore: boolean,
): ListRepositoriesPageResult {
  const pageItems = [...items];
  const last = pageItems.at(-1);
  return {
    items: pageItems,
    nextCursor:
      hasMore && last
        ? encodeRepositoryCursor(state, {
            ...parsed.cursorBase,
            position: { name: last.name, id: last.id },
          })
        : null,
  };
}

/** Cursor page of repositories. Principal scope is applied before slicing. */
export function listRepositoriesPage(
  state: ControlPlaneState,
  query: ListRepositoriesPageQuery = {},
  records: readonly RepositoryRecord[] = listRepositories(state),
): ListRepositoriesPageResult {
  const parsed = parseRepositoryPageQuery(state, query);
  let rows = records
    .filter(
      (repository) => parsed.repositoryIds === null || parsed.repositoryIds.includes(repository.id),
    )
    .toSorted(compareRepositories);
  if (parsed.position) {
    rows = rows.filter(
      (repository) => compareRepositories(repository, { ...repository, ...parsed.position }) > 0,
    );
  }
  return pageResult(state, parsed, rows.slice(0, parsed.limit), rows.length > parsed.limit);
}

/**
 * Dynamo's catalog index is already sorted by the same name/id keyset, so a
 * durable continuation asks storage for only the next bounded window instead
 * of hydrating and re-slicing the whole repository catalog.
 */
export async function listRepositoriesPageDurable(
  state: ControlPlaneState,
  query: ListRepositoriesPageQuery = {},
): Promise<ListRepositoriesPageResult> {
  if (!state.storage) return listRepositoriesPage(state, query);
  // Keep test and third-party storage adapters written before the bounded
  // repository-page primitive compatible. Production Dynamo always has it.
  if (typeof state.storage.listRepositoriesPage !== "function") {
    await listRepositoriesDurable(state);
    return listRepositoriesPage(state, query);
  }
  const parsed = parseRepositoryPageQuery(state, query);
  const page = await state.storage.listRepositoriesPage({
    limit: parsed.limit,
    ...(parsed.position ? { after: parsed.position } : {}),
    ...(parsed.repositoryIds === null ? {} : { repositoryIds: parsed.repositoryIds }),
  });
  return pageResult(state, parsed, page.items, page.hasMore);
}

import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  decodeRepositoryCursor,
  encodeRepositoryCursor,
  normalizeRepositoryLimit,
  normalizeRepositoryScope,
} from "./control-plane-repository-cursor.ts";
import { compareRepositories, listRepositories } from "./control-plane-repos.ts";

export {
  InvalidRepositoryCursorError,
  InvalidRepositoryListQueryError,
  type ListRepositoriesPageQuery,
  type RepositoryListScope,
} from "./control-plane-repository-cursor.ts";
import type { ListRepositoriesPageQuery } from "./control-plane-repository-cursor.ts";

export type ListRepositoriesPageResult = {
  items: RepositoryRecord[];
  nextCursor: string | null;
};

/** Cursor page of repositories. Principal scope is applied before slicing. */
export function listRepositoriesPage(
  state: ControlPlaneState,
  query: ListRepositoriesPageQuery = {},
  records: readonly RepositoryRecord[] = listRepositories(state),
): ListRepositoriesPageResult {
  const limit = normalizeRepositoryLimit(query.limit);
  const scope = normalizeRepositoryScope(query.scope);
  const cursorBase = { version: 1 as const, domain: "repositories" as const, scope };
  const position = query.cursor
    ? decodeRepositoryCursor(state, query.cursor, cursorBase)
    : undefined;
  let rows = records
    .filter(
      (repository) => scope.repositoryIds === null || scope.repositoryIds.includes(repository.id),
    )
    .toSorted(compareRepositories);
  if (position) {
    rows = rows.filter(
      (repository) => compareRepositories(repository, { ...repository, ...position }) > 0,
    );
  }
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > items.length && last
        ? encodeRepositoryCursor(state, {
            ...cursorBase,
            position: { name: last.name, id: last.id },
          })
        : null,
  };
}

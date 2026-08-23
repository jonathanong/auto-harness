export type RepositoryPage<T = { id: string }> = {
  items?: T[];
  nextCursor?: string | null;
};

type RepositoryPageFetcher<T extends { id: string }> = (path: string) => Promise<RepositoryPage<T>>;

/** Return the API path for a repository page while keeping the cursor opaque. */
export function repositoryPagePath(
  cursor?: string | null,
  basePath = "/api/v1/repositories",
): string {
  const path = new URL(basePath, "http://auto-harness.local");
  if (cursor) path.searchParams.set("cursor", cursor);
  else path.searchParams.delete("cursor");
  return `${path.pathname}${path.search}`;
}

/**
 * Fetch every page of a repository catalog. Scope is enforced by the API on each request;
 * this helper only follows the opaque continuation cursor and never invents a page size.
 */
export async function loadAllRepositoryPages<T extends { id: string }>(
  fetchPage: RepositoryPageFetcher<T>,
  initialPage?: RepositoryPage<T>,
  initialPath = repositoryPagePath(),
): Promise<T[]> {
  let page = initialPage ?? (await fetchPage(initialPath));
  const items: T[] = [];
  const seenCursors = new Set<string>();
  for (;;) {
    items.push(...(page.items ?? []));
    const cursor = page.nextCursor ?? null;
    if (!cursor) return dedupeRepositories(items);
    if (seenCursors.has(cursor)) throw new Error("repository pagination cursor repeated");
    seenCursors.add(cursor);
    page = await fetchPage(repositoryPagePath(cursor, initialPath));
  }
}

export function dedupeRepositories<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

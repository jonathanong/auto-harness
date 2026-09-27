// Plan invariant 13: list commands may follow nextCursor, but only up to a fixed page cap.
export const MAX_ALL_PAGES = 20;

/**
 * Follows `nextCursor` from `fetchPage`, stopping after `MAX_ALL_PAGES` pages.
 * `nextCursor` in the result is set when the cap left more rows unread.
 * A cursor that repeats throws — that is a server bug, not a reason to keep walking.
 */
export async function collectAllPages(fetchPage, { startCursor, resourcePath, mapItem } = {}) {
  const items = [];
  const seenCursors = new Set();
  let cursor = startCursor;
  for (let pageCount = 0; pageCount < MAX_ALL_PAGES; pageCount += 1) {
    const page = await fetchPage(cursor);
    const pageItems = page.items ?? [];
    items.push(...(mapItem ? pageItems.map(mapItem) : pageItems));
    cursor = page.nextCursor || undefined;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new Error(`repeated pagination cursor for ${resourcePath}`);
    }
    seenCursors.add(cursor);
  }
  return { items, nextCursor: cursor };
}

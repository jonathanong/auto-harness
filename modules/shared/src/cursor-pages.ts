export type CursorPage<T> = { items?: T[]; nextCursor?: string | null };

/** Hard cap so catalog collectors cannot walk an unbounded table. 20 × 100 = 2,000 rows. */
export const MAX_CURSOR_PAGES = 20;

/** Collect an opaque-cursor API without allowing a replayed cursor to loop forever. */
export async function collectCursorPages<T>(
  path: string,
  load: (requestPath: string) => Promise<CursorPage<T>>,
  maxPages = MAX_CURSOR_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
    const page = await load(requestPath);
    items.push(...(page.items ?? []));
    const cursor = page.nextCursor ?? null;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(cursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
  throw new Error(`pagination exceeded ${maxPages} pages for ${path}`);
}

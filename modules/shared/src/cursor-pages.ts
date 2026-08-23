export type CursorPage<T> = { items?: T[]; nextCursor?: string | null };

/** Collect an opaque-cursor API without allowing a replayed cursor to loop forever. */
export async function collectCursorPages<T>(
  path: string,
  load: (requestPath: string) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let requestPath = path;
  while (true) {
    const page = await load(requestPath);
    items.push(...(page.items ?? []));
    const cursor = page.nextCursor ?? null;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new Error(`repeated pagination cursor for ${path}`);
    seen.add(cursor);
    requestPath = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
}

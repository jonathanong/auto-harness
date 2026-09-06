import { send, type RouteCtx } from "./local-http.ts";
import {
  InvalidListPageQueryError,
  pageByKey,
  parseListPageQuery,
  type ListPage,
} from "./control-plane-id-page.ts";

/** Send a bounded `{ items, nextCursor }` page, or 400 for a bad limit/cursor. */
export function sendListPage<T>(
  ctx: Pick<RouteCtx, "res" | "url">,
  items: readonly T[],
  key: (item: T) => string,
  compare?: (left: T, right: T) => number,
): void {
  try {
    send(ctx.res, 200, pageList(ctx.url, items, key, compare));
  } catch (error) {
    if (error instanceof InvalidListPageQueryError) {
      send(ctx.res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
      return;
    }
    throw error;
  }
}

export function pageList<T>(
  url: URL,
  items: readonly T[],
  key: (item: T) => string,
  compare?: (left: T, right: T) => number,
): ListPage<T> {
  const query = parseListPageQuery(url);
  return pageByKey(items, { ...query, key, ...(compare ? { compare } : {}) });
}

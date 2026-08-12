/** Shared list/cursor query helpers for UIs (control + host panes). */

export type SessionListQuery = {
  status: string;
  q: string;
  concurrencyId: string;
  cursor: string;
  limit: number;
  repositoryId: string;
  scheduleId: string;
  hostId: string;
  source: string;
  sort: "latest" | "oldest" | "priority_desc" | "priority_asc";
};

export function parseSessionListQuery(
  sp: URLSearchParams,
  defaults: { limit?: number } = {},
): SessionListQuery {
  const limitRaw = sp.get("limit");
  const limitNum = limitRaw ? Number(limitRaw) : (defaults.limit ?? 50);
  const sortRaw = sp.get("sort");
  const sort =
    sortRaw === "oldest" || sortRaw === "priority_desc" || sortRaw === "priority_asc"
      ? sortRaw
      : "latest";
  return {
    status: sp.get("status") ?? "all",
    q: sp.get("q") ?? "",
    concurrencyId: sp.get("concurrencyId") ?? "",
    cursor: sp.get("cursor") ?? "",
    limit: Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 100) : 50,
    repositoryId: sp.get("repositoryId") ?? "",
    scheduleId: sp.get("scheduleId") ?? "",
    hostId: sp.get("hostId") ?? "",
    source: sp.get("source") ?? "",
    sort,
  };
}

export function sessionListHref(state: Partial<SessionListQuery>, basePath = "/sessions"): string {
  const p = new URLSearchParams();
  if (state.status && state.status !== "all") {
    p.set("status", state.status);
  }
  if (state.q) {
    p.set("q", state.q);
  }
  if (state.concurrencyId) {
    p.set("concurrencyId", state.concurrencyId);
  }
  if (state.repositoryId) {
    p.set("repositoryId", state.repositoryId);
  }
  if (state.scheduleId) {
    p.set("scheduleId", state.scheduleId);
  }
  if (state.hostId) p.set("hostId", state.hostId);
  if (state.source) p.set("source", state.source);
  if (state.sort && state.sort !== "latest") {
    p.set("sort", state.sort);
  }
  if (state.cursor) {
    p.set("cursor", state.cursor);
  }
  if (state.limit && state.limit !== 50) {
    p.set("limit", String(state.limit));
  }
  const s = p.toString();
  return s ? `${basePath}?${s}` : basePath;
}

export function buildSessionsApiPath(query: SessionListQuery, extra?: { hostId?: string }): string {
  const p = new URLSearchParams();
  p.set("limit", String(query.limit));
  if (query.cursor) {
    p.set("cursor", query.cursor);
  }
  if (query.status && query.status !== "all") {
    p.set("status", query.status);
  }
  if (query.repositoryId) {
    p.set("repositoryId", query.repositoryId);
  }
  if (query.scheduleId) {
    p.set("scheduleId", query.scheduleId);
  }
  if (query.hostId) p.set("hostId", query.hostId);
  if (query.source) p.set("source", query.source);
  if (query.sort && query.sort !== "latest") {
    p.set("sort", query.sort);
  }
  if (query.concurrencyId) {
    p.set("concurrencyId", query.concurrencyId);
  }
  if (extra?.hostId) {
    p.set("hostId", extra.hostId);
  }
  return `/api/v1/sessions?${p.toString()}`;
}

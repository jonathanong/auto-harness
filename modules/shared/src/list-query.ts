/** Shared list/cursor query helpers for UIs (control + agent panes). */

export type SessionListQuery = {
  status: string;
  q: string;
  cursor: string;
  limit: number;
};

export function parseSessionListQuery(
  sp: URLSearchParams,
  defaults: { limit?: number } = {},
): SessionListQuery {
  const limitRaw = sp.get("limit");
  const limitNum = limitRaw ? Number(limitRaw) : (defaults.limit ?? 20);
  return {
    status: sp.get("status") ?? "all",
    q: sp.get("q") ?? "",
    cursor: sp.get("cursor") ?? "",
    limit: Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 100) : 20,
  };
}

export function sessionListHref(
  state: Partial<SessionListQuery>,
  basePath = "/sessions",
): string {
  const p = new URLSearchParams();
  if (state.status && state.status !== "all") {
    p.set("status", state.status);
  }
  if (state.q) {
    p.set("q", state.q);
  }
  if (state.cursor) {
    p.set("cursor", state.cursor);
  }
  if (state.limit && state.limit !== 20) {
    p.set("limit", String(state.limit));
  }
  const s = p.toString();
  return s ? `${basePath}?${s}` : basePath;
}

export function buildSessionsApiPath(query: SessionListQuery, extra?: { agentId?: string }): string {
  const p = new URLSearchParams();
  p.set("limit", String(query.limit));
  if (query.cursor) {
    p.set("cursor", query.cursor);
  }
  if (query.status && query.status !== "all") {
    p.set("status", query.status);
  }
  if (query.q) {
    p.set("q", query.q);
  }
  if (extra?.agentId) {
    p.set("agentId", extra.agentId);
  }
  return `/api/v1/sessions?${p.toString()}`;
}

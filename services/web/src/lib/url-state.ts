/** Read/write filter state only via URL search params (issue #2). */

import {
  parseSessionListQuery,
  sessionListHref as sharedSessionListHref,
  type SessionListQuery,
} from "@auto-harness/shared";

export function parseSessionListState(sp: URLSearchParams): SessionListQuery {
  return parseSessionListQuery(sp);
}

export function sessionListHref(state: Partial<SessionListQuery>): string {
  return sharedSessionListHref(state, "/sessions");
}

type HostListState = {
  online: string;
};

export function parseHostListState(sp: URLSearchParams): HostListState {
  return { online: sp.get("online") ?? "all" };
}

export function hostListHref(state: Partial<HostListState>): string {
  const p = new URLSearchParams();
  if (state.online && state.online !== "all") {
    p.set("online", state.online);
  }
  const s = p.toString();
  return s ? `/hosts?${s}` : "/hosts";
}

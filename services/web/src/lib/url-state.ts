/** Read/write filter state only via URL search params (issue #2). */

import {
  parseSessionListQuery,
  sessionListHref as sharedSessionListHref,
  type SessionListQuery,
} from "@auto-harness/shared";

type SessionListState = SessionListQuery;

export function parseSessionListState(sp: URLSearchParams): SessionListState {
  return parseSessionListQuery(sp);
}

export function sessionListHref(state: Partial<SessionListState>): string {
  return sharedSessionListHref(state, "/sessions");
}

type AgentListState = {
  online: string;
};

export function parseAgentListState(sp: URLSearchParams): AgentListState {
  return { online: sp.get("online") ?? "all" };
}

export function agentListHref(state: Partial<AgentListState>): string {
  const p = new URLSearchParams();
  if (state.online && state.online !== "all") {
    p.set("online", state.online);
  }
  const s = p.toString();
  return s ? `/agents?${s}` : "/agents";
}

/** Read/write filter state only via URL search params (issue #2). */

type SessionListState = {
  status: string;
  q: string;
};

export function parseSessionListState(sp: URLSearchParams): SessionListState {
  return {
    status: sp.get("status") ?? "all",
    q: sp.get("q") ?? "",
  };
}

export function sessionListHref(state: Partial<SessionListState>): string {
  const p = new URLSearchParams();
  if (state.status && state.status !== "all") {
    p.set("status", state.status);
  }
  if (state.q) {
    p.set("q", state.q);
  }
  const s = p.toString();
  return s ? `/sessions?${s}` : "/sessions";
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

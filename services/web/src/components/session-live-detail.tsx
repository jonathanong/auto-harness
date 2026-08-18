"use client";

import { isTerminalSessionStatus } from "@auto-harness/shared";
import { Alert, SessionActions, SessionDetail, type SessionSummary } from "@auto-harness/ui";
import { type ReactNode, useEffect, useState } from "react";

import { apiFetch } from "../lib/client-api.ts";

type Host = { hostId: string; online: boolean };

const SESSION_STATE_POLL_MS = 5_000;

export function assignedHostIsOffline(session: SessionSummary, hosts: Host[]): boolean {
  if (session.status !== "running" || !session.hostId) return false;
  return hosts.find((host) => host.hostId === session.hostId)?.online === false;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${path} failed`);
  return (await response.json()) as T;
}

export async function fetchSessionLiveState(sessionId: string): Promise<{
  session: SessionSummary;
  hosts: Host[];
}> {
  const session = await getJson<SessionSummary>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
  );
  const hosts =
    session.status === "running" && session.hostId
      ? ((await getJson<{ items?: Host[] }>("/api/v1/hosts")).items ?? [])
      : [];
  return { session, hosts };
}

export function SessionLiveDetail({
  initialSession,
  initialHosts,
  children,
}: {
  initialSession: SessionSummary;
  initialHosts: Host[];
  children?: ReactNode;
}) {
  const [session, setSession] = useState(initialSession);
  const [hosts, setHosts] = useState(initialHosts);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const offline = assignedHostIsOffline(session, hosts);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    // Returns false once the session reaches a terminal status: nothing can change after
    // that, and re-arming anyway left every open tab polling a finished session forever.
    const refresh = async (): Promise<boolean> => {
      try {
        const next = await fetchSessionLiveState(initialSession.id);
        if (!active) return false;
        setSession(next.session);
        setHosts(next.hosts);
        setRefreshFailed(false);
        return !isTerminalSessionStatus(next.session.status);
      } catch {
        if (active) setRefreshFailed(true);
        return true;
      }
    };
    const poll = async () => {
      const keepPolling = await refresh();
      if (active && keepPolling) timer = setTimeout(() => void poll(), SESSION_STATE_POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [initialSession.id]);

  return (
    <SessionDetail
      session={session}
      breadcrumbs={[{ label: "Sessions", href: "/sessions" }, { label: session.id }]}
      actions={
        <SessionActions
          sessionId={session.id}
          status={session.status}
          assignedHostOffline={offline}
          cloneEditHref={`/sessions/new?cloneFrom=${encodeURIComponent(session.id)}`}
        />
      }
      repoHrefBase="/repositories"
      hostHrefBase="/hosts"
      worktreeHrefBase="/worktrees"
    >
      {offline ? (
        <Alert variant="warning" className="p-4" data-pw="session-agent-offline" role="alert">
          <p className="font-medium">Agent disconnected — session may be stale.</p>
          <p className="mt-1">
            Force-cancel updates the control-plane session, but cannot confirm that the remote
            process stopped while the agent is offline.
          </p>
        </Alert>
      ) : null}
      {refreshFailed ? (
        <p className="text-sm text-amber-800" data-pw="session-live-state-error" role="status">
          Session and agent status refresh paused; retrying…
        </p>
      ) : null}
      {children}
    </SessionDetail>
  );
}

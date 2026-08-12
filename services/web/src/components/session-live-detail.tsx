"use client";

import { SessionActions, SessionDetail, type SessionSummary } from "@auto-harness/ui";
import { type ReactNode, useEffect, useState } from "react";

type Host = { hostId: string; online: boolean };

const SESSION_STATE_POLL_MS = 5_000;

export function assignedHostIsOffline(session: SessionSummary, hosts: Host[]): boolean {
  if (session.status !== "running" || !session.hostId) return false;
  return hosts.find((host) => host.hostId === session.hostId)?.online === false;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
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
    const refresh = async () => {
      try {
        const next = await fetchSessionLiveState(initialSession.id);
        if (!active) return;
        setSession(next.session);
        setHosts(next.hosts);
        setRefreshFailed(false);
      } catch {
        if (active) setRefreshFailed(true);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), SESSION_STATE_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
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
        <div
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          data-pw="session-agent-offline"
          role="alert"
        >
          <p className="font-medium">Agent disconnected — session may be stale.</p>
          <p className="mt-1">
            Force-cancel updates the control-plane session, but cannot confirm that the remote
            process stopped while the agent is offline.
          </p>
        </div>
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

"use client";

import { SessionActions, SessionDetail, type SessionSummary } from "@auto-harness/ui";
import { type ReactNode, useEffect, useState } from "react";

const SESSION_STATE_POLL_MS = 5_000;

export async function fetchSessionLiveState(sessionId: string): Promise<SessionSummary> {
  const path = `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`GET ${path} failed`);
  return (await response.json()) as SessionSummary;
}

/** Keeps host-pane session status current while retaining the server-rendered initial view. */
export function SessionLiveDetail({
  initialSession,
  children,
}: {
  initialSession: SessionSummary;
  children?: ReactNode;
}) {
  const [session, setSession] = useState(initialSession);
  const [refreshFailed, setRefreshFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await fetchSessionLiveState(initialSession.id);
        if (!active) return;
        setSession(next);
        setRefreshFailed(false);
      } catch {
        if (active) setRefreshFailed(true);
      }
      if (active) timer = setTimeout(() => void poll(), SESSION_STATE_POLL_MS);
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
      actions={<SessionActions sessionId={session.id} status={session.status} />}
      repoHrefBase="/repositories"
      worktreeHrefBase="/worktrees"
    >
      {refreshFailed ? (
        <p className="text-sm text-amber-800" data-pw="session-live-state-error" role="status">
          Session status refresh paused; retrying…
        </p>
      ) : null}
      {children}
    </SessionDetail>
  );
}

"use client";

import { thrownMessage } from "@auto-harness/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Alert,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SessionStatusBadge,
  TipText,
} from "@auto-harness/ui";

import {
  formatSessionCount,
  getItemPage,
  getItems,
  getSessionCount,
  type DashboardHost,
  type DashboardSession,
  type DashboardSnapshot,
  type DashboardWorktree,
} from "../lib/dashboard-metrics.ts";
import { DashboardEmptyStates } from "./dashboard-empty-states.tsx";
import { DashboardMetricCard } from "./dashboard-metric-card.tsx";

export type {
  DashboardHost,
  DashboardSession,
  DashboardSnapshot,
  DashboardWorktree,
  SessionCount,
} from "../lib/dashboard-metrics.ts";

type DashboardLiveProps = {
  initial: DashboardSnapshot;
  initialError?: string | null;
  pollMs?: number;
};

export function DashboardLive({
  initial,
  initialError = null,
  pollMs = 5_000,
}: DashboardLiveProps) {
  const [snapshot, setSnapshot] = useState(initial);
  const [error, setError] = useState<string | null>(initialError);
  const refreshing = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [sessions, hosts, worktrees, running, queued] = await Promise.all([
        getItems<DashboardSession>("/api/v1/sessions?limit=50"),
        getItemPage<DashboardHost>("/api/v1/hosts?limit=100"),
        getItemPage<DashboardWorktree>("/api/v1/worktrees?limit=100"),
        getSessionCount("running"),
        getSessionCount("queued"),
      ]);
      setSnapshot({
        sessions,
        running,
        queued,
        hosts: hosts.items,
        worktrees: worktrees.items,
        hostsAtLimit: hosts.atLimit,
        worktreesAtLimit: worktrees.atLimit,
      });
      setError(null);
    } catch (reason) {
      setError(thrownMessage(reason));
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), pollMs);
    };
    timer = setTimeout(() => void poll(), pollMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollMs, refresh]);

  const metrics = useMemo(() => {
    const onlineHosts = snapshot.hosts.filter((item) => item.online).length;
    const onlineWorktrees = snapshot.worktrees.filter((item) => item.online !== false);
    const busy = onlineWorktrees.filter((item) => item.status === "busy").length;
    const idle = onlineWorktrees.filter((item) => item.status === "idle").length;
    const unavailable = snapshot.worktrees.length - busy - idle;
    return { busy, idle, onlineHosts, unavailable };
  }, [snapshot]);

  return (
    <>
      {error ? (
        <Alert
          variant="warning"
          className="flex items-center justify-between gap-3"
          role="alert"
          data-pw="live-updates-paused"
        >
          <span>Live updates paused ({error}). Showing the last successful snapshot.</span>
          <button className="font-medium underline" type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </Alert>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          aria-live="polite"
          data-pw="live-updates-active"
        >
          Live updates active
        </p>
      )}

      <DashboardEmptyStates
        showSessions={!error && snapshot.sessions.length === 0}
        showHosts={!error && (snapshot.hosts.length === 0 || metrics.onlineHosts === 0)}
        hasOnlineHost={metrics.onlineHosts > 0}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-pw="dashboard-stats">
        <DashboardMetricCard
          label="Running"
          value={formatSessionCount(snapshot.running)}
          tip="Sessions currently executing on a host"
          pw="stat-running"
        />
        <DashboardMetricCard
          label="Queued"
          value={formatSessionCount(snapshot.queued)}
          tip="Sessions waiting for an available host worktree"
          pw="stat-queued"
        />
        <DashboardMetricCard
          label="Hosts online"
          value={`${metrics.onlineHosts}/${snapshot.hosts.length}${snapshot.hostsAtLimit ? "+" : ""}`}
          tip="Hosts with a live connection / known hosts; 100+ means more pages exist"
          pw="stat-hosts-online"
        />
        <DashboardMetricCard
          label="Worktree utilization"
          value={`${metrics.busy}/${metrics.busy + metrics.idle}${snapshot.worktreesAtLimit ? "+" : ""} busy`}
          detail={`${metrics.unavailable} offline or unavailable`}
          tip="Busy / available online worktrees; offline and error worktrees are excluded"
          pw="stat-worktree-utilization"
        />
      </div>

      <Card data-pw="dashboard-recent-sessions">
        <CardHeader>
          <CardTitle className="text-base">
            <TipText tip="Most recent sessions from the control plane">Recent sessions</TipText>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {snapshot.sessions.slice(0, 8).map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-2 text-sm">
              <Link
                href={`/sessions/${encodeURIComponent(session.id)}`}
                className="font-mono hover:underline"
              >
                {session.id}
              </Link>
              <SessionStatusBadge status={session.status} />
            </div>
          ))}
          {snapshot.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent sessions.</p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

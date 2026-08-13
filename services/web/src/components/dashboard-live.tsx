"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, StatusBadge, TipText } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export type DashboardSession = { id: string; status: string; prompt?: string };
export type DashboardHost = { hostId: string; online: boolean };
export type DashboardWorktree = { id: string; status?: string; online?: boolean };

export type DashboardSnapshot = {
  sessions: DashboardSession[];
  hosts: DashboardHost[];
  worktrees: DashboardWorktree[];
};

type DashboardLiveProps = {
  initial: DashboardSnapshot;
  initialError?: string | null;
  pollMs?: number;
};

async function getItems<T>(path: string): Promise<T[]> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  const data = (await response.json()) as { items?: T[] };
  return data.items ?? [];
}

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
      const [sessions, hosts, worktrees] = await Promise.all([
        getItems<DashboardSession>("/api/v1/sessions"),
        getItems<DashboardHost>("/api/v1/hosts"),
        getItems<DashboardWorktree>("/api/v1/worktrees"),
      ]);
      setSnapshot({ sessions, hosts, worktrees });
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
    const running = snapshot.sessions.filter((item) => item.status === "running").length;
    const queued = snapshot.sessions.filter((item) => item.status === "queued").length;
    const onlineHosts = snapshot.hosts.filter((item) => item.online).length;
    const onlineWorktrees = snapshot.worktrees.filter((item) => item.online !== false);
    const busy = onlineWorktrees.filter((item) => item.status === "busy").length;
    const idle = onlineWorktrees.filter((item) => item.status === "idle").length;
    const unavailable = snapshot.worktrees.length - busy - idle;
    return { busy, idle, onlineHosts, queued, running, unavailable };
  }, [snapshot]);

  return (
    <>
      {error ? (
        <div
          className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-50 p-3 text-sm text-yellow-950"
          role="alert"
          data-pw="live-updates-paused"
        >
          <span>Live updates paused ({error}). Showing the last successful snapshot.</span>
          <button className="font-medium underline" type="button" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          aria-live="polite"
          data-pw="live-updates-active"
        >
          Live updates active
        </p>
      )}

      {snapshot.hosts.length === 0 || metrics.onlineHosts === 0 ? (
        <p
          className="rounded-md border border-yellow-500/50 bg-yellow-50 p-3 text-sm"
          data-pw="dashboard-no-online-hosts"
        >
          No hosts connected.{" "}
          <Link className="font-medium underline" href="/hosts">
            Set up a host
          </Link>
          .
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-pw="dashboard-stats">
        <MetricCard
          label="Running"
          value={String(metrics.running)}
          tip="Sessions currently executing on a host"
          pw="stat-running"
        />
        <MetricCard
          label="Queued"
          value={String(metrics.queued)}
          tip="Sessions waiting for an available host worktree"
          pw="stat-queued"
        />
        <MetricCard
          label="Hosts online"
          value={`${metrics.onlineHosts}/${snapshot.hosts.length}`}
          tip="Hosts with a live connection / total known hosts"
          pw="stat-hosts-online"
        />
        <MetricCard
          label="Worktree utilization"
          value={`${metrics.busy}/${metrics.busy + metrics.idle} busy`}
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
              <StatusBadge status={session.status} />
            </div>
          ))}
          {snapshot.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Get started: add a repository, connect a host, then create your first session.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tip,
  pw,
}: {
  label: string;
  value: string;
  detail?: string;
  tip: string;
  pw: string;
}) {
  return (
    <Card data-pw={pw}>
      <CardHeader>
        <CardTitle className="text-base">
          <TipText tip={tip}>{label}</TipText>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-3xl font-semibold">
        <span data-pw={`${pw}-value`}>{value}</span>
        {detail ? (
          <span
            className="mt-1 block text-xs font-normal text-muted-foreground"
            data-pw={`${pw}-detail`}
          >
            {detail}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

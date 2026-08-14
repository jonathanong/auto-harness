import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { ListApiError } from "../../components/list-page-states.tsx";
import { PrimaryEmptyState } from "../../components/primary-empty-state.tsx";
import { ScheduleCreateForm } from "../../components/schedule-create-form.tsx";
import { ScheduleEnabledToggle } from "../../components/schedule-enabled-toggle.tsx";
import { ScheduleTriggerButton } from "../../components/schedule-trigger-button.tsx";
import { apiGet } from "../../lib/api.ts";
import { describeCron } from "../../lib/schedule-cron-label.ts";
import type { SessionTarget } from "../../session-target.ts";

export const dynamic = "force-dynamic";

type Schedule = {
  id: string;
  name: string;
  repositoryId: string;
  targetLabels: string[];
  target: { providerId: string } | { commandId: string };
  fallbacks: Array<{ providerId: string } | { commandId: string }>;
  cron: string;
  enabled: boolean;
  timeout: number;
  queueTtlSeconds: number;
  nextRunAt: string;
  ref?: string;
  lastRunAt: string | null;
  concurrencyId?: string | null;
  activeSessionId?: string | null;
};

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawSearchParams = await searchParams;
  const editId = typeof rawSearchParams.edit === "string" ? rawSearchParams.edit : null;
  let items: Schedule[] = [];
  let targets: SessionTarget[] = [];
  let error: string | null = null;
  try {
    const [schedulesData, targetsData] = await Promise.all([
      apiGet<{ items: Schedule[] }>("/api/v1/schedules"),
      apiGet<{ items: SessionTarget[] }>("/api/v1/session-targets"),
    ]);
    items = schedulesData.items ?? [];
    targets = targetsData.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const editing = editId ? items.find((schedule) => schedule.id === editId) : undefined;

  return (
    <div className="space-y-6" data-pw="page-schedules">
      <h2 className="text-2xl font-semibold tracking-tight" data-pw="schedules-heading">
        Schedules
      </h2>
      {error ? (
        <ListApiError resource="schedules" message={error} selector="schedules" />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Repo</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Queue TTL</TableHead>
                <TableHead>Cron</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Concurrency ID</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Next</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((s) => (
                <TableRow key={s.id} data-pw={`schedule-row-${s.id}`}>
                  <TableCell>
                    <Link
                      href={`/schedules/${encodeURIComponent(s.id)}`}
                      className="hover:underline"
                    >
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      href={`/repositories/${encodeURIComponent(s.repositoryId)}`}
                      className="hover:underline"
                    >
                      {s.repositoryId}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div data-pw={`schedule-route-${s.id}`}>
                      {s.targetLabels?.join(" → ") ?? routeLabel(s.target) ?? "—"}
                    </div>
                    {s.fallbacks?.length ? (
                      <div className="text-xs text-muted-foreground">
                        {s.fallbacks.length} fallback{s.fallbacks.length === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">{s.queueTtlSeconds ?? 691200}s</TableCell>
                  <TableCell className="text-xs">
                    <span
                      title={`Cron: ${s.cron}`}
                      aria-describedby={`schedule-cron-raw-${s.id}`}
                      data-pw={`schedule-cron-${s.id}`}
                    >
                      {describeCron(s.cron)}
                    </span>
                    <span id={`schedule-cron-raw-${s.id}`} className="sr-only">
                      Cron expression: {s.cron}
                    </span>
                  </TableCell>
                  <TableCell>
                    <ScheduleEnabledToggle id={s.id} enabled={s.enabled} />
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-mono text-xs">
                    {s.concurrencyId ?? "—"}
                  </TableCell>
                  <TableCell>
                    {s.activeSessionId ? (
                      <Link
                        href={`/sessions/${encodeURIComponent(s.activeSessionId)}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {s.activeSessionId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{s.nextRunAt}</TableCell>
                  <TableCell className="text-xs">{s.lastRunAt ?? "—"}</TableCell>
                  <TableCell>
                    <ScheduleTriggerButton id={s.id} />
                    <Link
                      href={`/schedules?edit=${encodeURIComponent(s.id)}`}
                      className="text-sm hover:underline"
                      data-pw={`schedule-edit-${s.id}`}
                    >
                      Edit
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="text-muted-foreground">
                    <PrimaryEmptyState title="No schedules configured." pw="schedules-empty">
                      <p>Create a recurring task with a repository, target, and cron schedule.</p>
                      <Link
                        href="#schedule-create"
                        className="font-medium text-primary hover:underline"
                        data-pw="schedules-empty-create"
                      >
                        Create one →
                      </Link>
                    </PrimaryEmptyState>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div id="schedule-create">
            <h3 className="mb-2 text-lg font-medium">
              {editing ? `Edit ${editing.name}` : "Add schedule"}
            </h3>
            <ScheduleCreateForm targets={targets} schedule={editing} />
          </div>
        </>
      )}
    </div>
  );
}

function routeLabel(target?: { providerId?: string; commandId?: string } | null): string | null {
  if (!target) return null;
  if (target.providerId) return `provider:${target.providerId}`;
  if (target.commandId) return `command:${target.commandId}`;
  return null;
}

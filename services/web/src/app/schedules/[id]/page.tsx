import Link from "next/link";
import { ScheduleTriggerButton } from "../../../components/schedule-trigger-button.tsx";
import {
  ScheduleEditForm,
  type EditableSchedule,
} from "../../../components/schedule-edit-form.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { ApiError, apiGet } from "../../../lib/api.ts";
import type { SessionTarget } from "../../../session-target.ts";

export const dynamic = "force-dynamic";

type SessionHistory = {
  id: string;
  status: string;
  createdAt?: string;
  completedAt?: string | null;
};

export default async function ScheduleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let schedule: EditableSchedule | undefined;
  let targets: SessionTarget[] = [];
  let history: SessionHistory[] = [];
  try {
    schedule = await apiGet<EditableSchedule>(`/api/v1/schedules/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      schedule = undefined;
    } else {
      throw error;
    }
  }

  if (!schedule) {
    return (
      <div className="space-y-4" data-pw="page-schedule-detail-not-found">
        <Link href="/schedules" className="text-sm text-muted-foreground hover:underline">
          ← Back to schedules
        </Link>
        <p className="text-sm text-muted-foreground">
          No schedule <code className="font-mono">{id}</code> found.
        </p>
      </div>
    );
  }

  try {
    const data = await apiGet<{ items: SessionTarget[] }>("/api/v1/session-targets");
    targets = data.items ?? [];
  } catch {
    targets = [];
  }
  try {
    const query = new URLSearchParams({ scheduleId: schedule.id, limit: "100" });
    const data = await apiGet<{ items: SessionHistory[] }>(`/api/v1/sessions?${query.toString()}`);
    history = data.items ?? [];
  } catch {
    history = [];
  }

  return (
    <div className="space-y-6" data-pw="page-schedule-detail">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/schedules" className="text-sm text-muted-foreground hover:underline">
            ← Schedules
          </Link>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight" data-pw="schedule-detail-name">
            {schedule.name}
          </h2>
          <p className="font-mono text-xs text-muted-foreground">{schedule.id}</p>
          {schedule.activeSessionId ? (
            <Link
              href={`/sessions/${encodeURIComponent(schedule.activeSessionId)}`}
              className="text-sm text-muted-foreground hover:underline"
              data-pw="schedule-detail-active-session"
            >
              Active session: <code className="font-mono">{schedule.activeSessionId}</code>
            </Link>
          ) : null}
        </div>
        <ScheduleTriggerButton id={schedule.id} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <h3 className="text-lg font-medium">Edit schedule</h3>
          <ScheduleEditForm schedule={schedule} targets={targets} />
        </section>
        <section className="space-y-3">
          <h3 className="text-lg font-medium">Run history</h3>
          {schedule.concurrencyId ? (
            <p className="text-sm text-muted-foreground">
              Concurrency ID: <code className="font-mono">{schedule.concurrencyId}</code>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">No concurrency ID configured.</p>
          )}
          <Table data-pw="schedule-history-table">
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      href={`/sessions/${encodeURIComponent(session.id)}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {session.id}
                    </Link>
                  </TableCell>
                  <TableCell>{session.status}</TableCell>
                  <TableCell className="text-xs">{session.createdAt ?? "—"}</TableCell>
                </TableRow>
              ))}
              {history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    No runs yet.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </section>
      </div>
    </div>
  );
}

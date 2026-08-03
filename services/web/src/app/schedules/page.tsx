import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { ScheduleCreateForm } from "../../components/schedule-create-form.tsx";
import { ScheduleTriggerButton } from "../../components/schedule-trigger-button.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Schedule = {
  id: string;
  name: string;
  repositoryId: string;
  commandProfile: string;
  cron: string;
  enabled: boolean;
  nextRunAt: string;
};

export default async function SchedulesPage() {
  let items: Schedule[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Schedule[] }>("/api/v1/schedules");
    items = data.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-6" data-pw="page-schedules">
      <h2 className="text-2xl font-semibold tracking-tight" data-pw="schedules-heading">
        Schedules
      </h2>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Repo</TableHead>
            <TableHead>Profile</TableHead>
            <TableHead>Cron</TableHead>
            <TableHead>Next</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.name}</TableCell>
              <TableCell className="font-mono text-xs">
                <Link href="/repositories" className="hover:underline">
                  {s.repositoryId}
                </Link>
              </TableCell>
              <TableCell>{s.commandProfile}</TableCell>
              <TableCell className="font-mono text-xs">{s.cron}</TableCell>
              <TableCell className="text-xs">{s.nextRunAt}</TableCell>
              <TableCell>
                <ScheduleTriggerButton id={s.id} />
              </TableCell>
            </TableRow>
          ))}
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                No schedules configured.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <div>
        <h3 className="mb-2 text-lg font-medium">Add schedule</h3>
        <ScheduleCreateForm />
      </div>
    </div>
  );
}

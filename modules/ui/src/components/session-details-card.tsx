"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent } from "./card.tsx";
import { SessionDetailTiming } from "./session-detail-timing.tsx";
import type { SessionSummary } from "./session-detail-types.ts";
import { SessionQueueDeadline } from "./session-queue-deadline.tsx";
import { SessionRouteSummary } from "./session-route-summary.tsx";
import { SessionTimeoutDetail } from "./session-timeout-progress.tsx";

export function SessionDetailsCard({
  session: s,
  detailsExtra,
  repoHrefBase,
  hostHrefBase,
  worktreeHrefBase,
}: {
  session: SessionSummary;
  detailsExtra?: ReactNode;
  repoHrefBase?: string;
  hostHrefBase?: string;
  worktreeHrefBase?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-6 pt-4">
        <DetailGroup title="Run">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Priority</dt>
            <dd className="text-sm" data-pw="session-detail-priority">
              {s.priority ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Concurrency ID</dt>
            <dd className="font-mono text-sm" data-pw="session-detail-concurrency-id">
              {s.concurrencyId ?? "—"}
            </dd>
          </div>
        </DetailGroup>
        <DetailGroup title="Where">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Repository</dt>
            <IdValue id={s.repositoryId} hrefBase={repoHrefBase} />
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Ref</dt>
            <dd className="font-mono text-sm">{s.ref ?? "—"}</dd>
          </div>
          {s.hostId ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Host</dt>
              <IdValue id={s.hostId} hrefBase={hostHrefBase} />
            </div>
          ) : null}
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Worktree</dt>
            <WorktreeValue session={s} hrefBase={worktreeHrefBase} />
          </div>
        </DetailGroup>
        <DetailGroup title="Route">
          <SessionRouteSummary session={s} />
        </DetailGroup>
        <DetailGroup title="Time">
          <SessionTimeoutDetail
            status={s.status}
            ackReceivedAt={s.ackReceivedAt}
            timeout={s.timeout}
          />
          <SessionDetailTiming
            createdAt={s.createdAt}
            startedAt={s.startedAt}
            completedAt={s.completedAt}
            status={s.status}
            durationPw={null}
          />
          <SessionQueueDeadline status={s.status} queueExpiresAt={s.queueExpiresAt} pw={null} />
        </DetailGroup>
        {detailsExtra}
      </CardContent>
    </Card>
  );
}

function DetailGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <dl className="grid gap-4 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function IdValue({
  id,
  hrefBase,
}: {
  id?: string | null | undefined;
  hrefBase?: string | undefined;
}) {
  return (
    <dd className="font-mono text-sm">
      {id ? (
        hrefBase ? (
          <Link href={`${hrefBase}/${encodeURIComponent(id)}`} className="hover:underline">
            {id}
          </Link>
        ) : (
          id
        )
      ) : (
        "—"
      )}
    </dd>
  );
}

function WorktreeValue({
  session: s,
  hrefBase,
}: {
  session: SessionSummary;
  hrefBase?: string | undefined;
}) {
  let body: ReactNode = "—";
  if (s.worktreeId) {
    body = hrefBase ? (
      <Link href={`${hrefBase}/${encodeURIComponent(s.worktreeId)}`} className="hover:underline">
        {s.worktreeId}
      </Link>
    ) : (
      s.worktreeId
    );
  } else if (s.type === "scheduled") {
    body = "Main checkout";
  }
  return (
    <dd className="font-mono text-sm" data-pw="session-detail-worktree">
      {body}
    </dd>
  );
}

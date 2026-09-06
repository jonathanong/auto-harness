import Link from "next/link";
import { USER_ROLE_LABELS, type UserRole } from "@auto-harness/shared";
import {
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { ListApiError } from "../../components/list-page-states.tsx";
import { PrimaryEmptyState } from "../../components/primary-empty-state.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type UserSession = {
  id: string;
  userId: string;
  username: string;
  role: UserRole | string | null;
  kind: "admin" | "user";
  connectedAt: string;
  lastHeartbeatAt: string;
  subscriptions: Array<{ sessionId: string; repositoryId: string; status: string }>;
};

function roleLabel(role: string | null): string {
  if (!role) return "—";
  return (USER_ROLE_LABELS as Record<string, string>)[role] ?? "—";
}

function WatchingCell({ item }: { item: UserSession }) {
  if (item.subscriptions.length === 0) return "—";
  return item.subscriptions.map((subscription, index) => (
    <span key={subscription.sessionId}>
      {index > 0 ? ", " : null}
      <Link
        href={`/sessions/${encodeURIComponent(subscription.sessionId)}`}
        className="hover:underline"
        data-pw={`user-session-watch-${item.id}-${subscription.sessionId}`}
      >
        {subscription.sessionId}
      </Link>
    </span>
  ));
}

function UserSessionsContent({ error, items }: { error: string | null; items: UserSession[] }) {
  if (error) {
    return <ListApiError resource="user sessions" message={error} selector="user-sessions" />;
  }
  if (items.length === 0) {
    return (
      <PrimaryEmptyState title="No live user sessions" pw="user-sessions-empty">
        <p>
          Opening a session&apos;s logs connects a browser viewer here. Host daemons stay on the
          Hosts page.
        </p>
      </PrimaryEmptyState>
    );
  }
  return (
    <Table data-pw="user-sessions-table">
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Connected</TableHead>
          <TableHead>Watching</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.id} data-pw={`user-session-row-${item.id}`}>
            <TableCell className="font-mono text-xs" data-pw={`user-session-user-${item.id}`}>
              {item.username}
            </TableCell>
            <TableCell data-pw={`user-session-role-${item.id}`}>{roleLabel(item.role)}</TableCell>
            <TableCell
              className="whitespace-nowrap text-xs"
              data-pw={`user-session-connected-${item.id}`}
            >
              <RelativeTime value={item.connectedAt} label="Connected" />
            </TableCell>
            <TableCell className="text-xs" data-pw={`user-session-watching-${item.id}`}>
              <WatchingCell item={item} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function UserSessionsPage() {
  let items: UserSession[] = [];
  let error: string | null = null;
  try {
    const response = await apiGet<{ items: UserSession[] }>("/api/v1/user-sessions");
    items = response.items ?? [];
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }

  return (
    <div className="space-y-4" data-pw="page-user-sessions">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="user-sessions-heading">
          User Sessions
        </h2>
        <p className="text-sm text-muted-foreground">
          Live browser connections tailing session logs. These are not host daemons and not CLI
          sessions.
        </p>
      </div>
      <UserSessionsContent error={error} items={items} />
    </div>
  );
}

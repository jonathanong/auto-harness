"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { thrownMessage, USER_ROLE_LABELS, type UserRole } from "@auto-harness/shared";
import {
  RelativeTime,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";
import { ListApiError } from "./list-page-states.tsx";
import { PrimaryEmptyState } from "./primary-empty-state.tsx";

export type UserSession = {
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

function WatchingCell({ item }: Readonly<{ item: UserSession }>) {
  if (item.subscriptions.length === 0) return "—";
  return item.subscriptions.map((subscription, index) => (
    <span key={subscription.sessionId}>
      {index > 0 ? ", " : null}
      <Link
        href={`/sessions/${encodeURIComponent(subscription.sessionId)}`}
        className="hover:underline"
        data-pw={`user-session-watch-${subscription.sessionId}`}
      >
        {subscription.sessionId}
      </Link>
    </span>
  ));
}

function UserSessionsContent({
  error,
  items,
}: Readonly<{ error: string | null; items: UserSession[] }>) {
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

export function UserSessionsLive({
  initialItems,
  initialError = null,
  pollMs = 5_000,
}: Readonly<{
  initialItems: UserSession[];
  initialError?: string | null;
  pollMs?: number;
}>) {
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await apiFetch("/api/v1/user-sessions?limit=100");
        if (!response.ok) throw new Error(`GET /api/v1/user-sessions → ${response.status}`);
        const body = (await response.json()) as { items?: UserSession[] };
        if (active) {
          setItems(body.items ?? []);
          setError(null);
        }
      } catch (reason) {
        if (active) setError(thrownMessage(reason));
      }
      if (active) timer = setTimeout(() => void poll(), pollMs);
    };
    timer = setTimeout(() => void poll(), Math.min(250, pollMs));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollMs]);

  return <UserSessionsContent error={error} items={items} />;
}

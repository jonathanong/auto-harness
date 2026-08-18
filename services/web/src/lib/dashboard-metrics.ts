import { apiFetch } from "./client-api.ts";

export type DashboardSession = { id: string; status: string; prompt?: string };
export type DashboardHost = { hostId: string; online: boolean };
export type DashboardWorktree = { id: string; status?: string; online?: boolean };

/**
 * `count` is exact up to the 100-item server-side limit; `atLimit` means the real total may be
 * higher (the API's `nextCursor` came back non-null) — the UI shows "100+" rather than a number
 * that looks precise but isn't.
 */
export type SessionCount = { count: number; atLimit: boolean };

export type DashboardSnapshot = {
  sessions: DashboardSession[];
  hosts: DashboardHost[];
  worktrees: DashboardWorktree[];
  running: SessionCount;
  queued: SessionCount;
};

export async function getItems<T>(path: string): Promise<T[]> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  const data = (await response.json()) as { items?: T[] };
  return data.items ?? [];
}

/**
 * Counts sessions by status directly via the server's own filter, instead of deriving a count
 * from a newest-N unfiltered window — a long-queued session otherwise drops out of that window
 * (and out of the count) the moment enough newer sessions arrive, even though it's still queued.
 */
export async function getSessionCount(status: "running" | "queued"): Promise<SessionCount> {
  const response = await apiFetch(`/api/v1/sessions?status=${status}&limit=100`);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  const data = (await response.json()) as { items?: unknown[]; nextCursor?: string | null };
  return { count: data.items?.length ?? 0, atLimit: (data.nextCursor ?? null) !== null };
}

export function formatSessionCount({ count, atLimit }: SessionCount): string {
  return atLimit ? `${count}+` : String(count);
}

import { apiFetchFirstPageWithItems } from "./client-api.ts";

export type DashboardSession = { id: string; status: string; prompt?: string };
export type DashboardHost = { hostId: string; online: boolean };
export type DashboardWorktree = { id: string; status?: string; online?: boolean };

/**
 * `count` is the first non-empty bounded page; `atLimit` means the real total may be higher (the
 * API's `nextCursor` came back non-null), so the UI adds "+" rather than implying precision.
 */
export type SessionCount = { count: number; atLimit: boolean };

export type DashboardSnapshot = {
  sessions: DashboardSession[];
  hosts: DashboardHost[];
  worktrees: DashboardWorktree[];
  hostsAtLimit: boolean;
  worktreesAtLimit: boolean;
  running: SessionCount;
  queued: SessionCount;
};

export type ItemPage<T> = { items: T[]; atLimit: boolean };

export async function getItems<T>(path: string): Promise<T[]> {
  return (await getItemPage<T>(path)).items;
}

export async function getItemPage<T>(path: string): Promise<ItemPage<T>> {
  const { response, items, nextCursor } = await apiFetchFirstPageWithItems<T>(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return { items, atLimit: nextCursor !== null };
}

/**
 * Counts sessions by status directly via the server's own filter, instead of deriving a count
 * from a newest-N unfiltered window — a long-queued session otherwise drops out of that window
 * (and out of the count) the moment enough newer sessions arrive, even though it's still queued.
 */
export async function getSessionCount(status: "running" | "queued"): Promise<SessionCount> {
  const { response, items, nextCursor } = await apiFetchFirstPageWithItems<unknown>(
    `/api/v1/sessions?status=${status}&limit=100`,
  );
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return { count: items.length, atLimit: nextCursor !== null };
}

export function formatSessionCount({ count, atLimit }: SessionCount): string {
  return atLimit ? `${count}+` : String(count);
}

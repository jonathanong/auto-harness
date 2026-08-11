import type { HostToServerMessage } from "@auto-harness/shared";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  aggregateUsage,
  costFromRates,
  type UsageAggregate,
  type UsageRecord,
  usageKindConflicts,
  validateUsage,
} from "./usage.ts";
export { aggregateUsage } from "./usage.ts";

type UsageMessage = Extract<HostToServerMessage, { type: "session:usage" }>;

function mapKey(record: UsageRecord): string {
  return `${record.sessionId}\0${record.attemptId}\0${record.sequence}`;
}

export function usageRecords(state: ControlPlaneState, sessionId?: string): UsageRecord[] {
  return [...state.usageRecords.values()].filter(
    (record) => !sessionId || record.sessionId === sessionId,
  );
}

export function usageAggregate(state: ControlPlaneState, sessionId?: string): UsageAggregate {
  return aggregateUsage(usageRecords(state, sessionId));
}

function buildRecord(
  state: ControlPlaneState,
  session: NonNullable<ControlPlaneState["sessions"] extends Map<string, infer V> ? V : never>,
  msg: UsageMessage,
): UsageRecord {
  const accountId = session.resolvedRoute?.providerAccountId;
  const account = accountId ? state.providerAccounts.get(accountId) : undefined;
  const provider = account?.providerId ? state.providers.get(account.providerId) : undefined;
  const costMicros =
    msg.usage.costMicros ??
    (provider?.usageRates ? costFromRates(msg.usage, provider.usageRates) : undefined);
  return {
    ...msg.usage,
    ...(costMicros !== undefined ? { costMicros } : {}),
    ...(msg.usage.currency === undefined && provider?.usageRates
      ? { currency: provider.usageRates.currency }
      : {}),
    sessionId: session.id,
    repositoryId: session.repositoryId,
    ...(account?.providerId ? { providerId: account.providerId } : {}),
    ...(accountId ? { providerAccountId: accountId } : {}),
    ...(session.resolvedRoute?.commandId ? { commandId: session.resolvedRoute.commandId } : {}),
    attemptId: msg.attemptId,
    worktreeId: msg.worktreeId,
    receivedAt: state.now(),
  };
}

export function ingestUsage(
  state: ControlPlaneState,
  msg: UsageMessage,
): { ok: boolean; error?: string } {
  const session = state.sessions.get(msg.sessionId);
  if (!session) return { ok: false, error: "session not found" };
  if (!validateUsage(msg.usage)) return { ok: false, error: "invalid usage report" };
  if (session.attemptId !== msg.attemptId || session.worktreeId !== msg.worktreeId)
    return { ok: true };
  if (state.storage) return { ok: false, error: "durable usage ingestion requires await" };
  const record = buildRecord(state, session, msg);
  const existing = usageRecords(state, session.id).filter(
    (item) => item.attemptId === msg.attemptId,
  );
  if (usageKindConflicts(existing, msg.usage.kind))
    return { ok: false, error: "usage report kind conflicts with this attempt" };
  state.usageRecords.set(mapKey(record), record);
  return { ok: true };
}

export async function ingestUsageDurable(
  state: ControlPlaneState,
  msg: UsageMessage,
  fence?: { hostId: string; connectionId: string },
): Promise<{ ok: boolean; error?: string }> {
  const session = state.storage
    ? await state.storage.getSession(msg.sessionId)
    : state.sessions.get(msg.sessionId);
  if (!session) return { ok: false, error: "session not found" };
  state.sessions.set(session.id, session);
  if (!validateUsage(msg.usage)) return { ok: false, error: "invalid usage report" };
  if (session.attemptId !== msg.attemptId || session.worktreeId !== msg.worktreeId)
    return { ok: true };
  // Durable reports must arrive through the fenced host WebSocket. A
  // no-fence write cannot safely bind the per-attempt kind marker to the
  // current host epoch, so reject it instead of falling back to an unsafe Put.
  if (state.storage && !fence)
    return { ok: false, error: "usage report requires host connection fence" };
  const accountId = session.resolvedRoute?.providerAccountId;
  if (accountId && state.storage) {
    const account = await state.storage.getProviderAccount(accountId);
    if (account) {
      state.providerAccounts.set(account.id, account);
      const provider = await state.storage.getProvider(account.providerId);
      if (provider) state.providers.set(provider.id, provider);
    }
  }
  const record = buildRecord(state, session, msg);
  const existing = state.storage
    ? (await state.storage.listUsageRecords(session.id)).filter(
        (item) => item.attemptId === msg.attemptId,
      )
    : usageRecords(state, session.id).filter((item) => item.attemptId === msg.attemptId);
  if (usageKindConflicts(existing, msg.usage.kind))
    return { ok: false, error: "usage report kind conflicts with this attempt" };
  if (state.storage && !(await state.storage.putUsageRecord(record, fence))) {
    // A conditional transaction failure is normally an idempotent duplicate,
    // but it can also mean another worker installed the opposite kind after
    // our initial read. Re-read the durable attempt marker's evidence so a
    // concurrent kind conflict is not reported as a successful duplicate.
    const after = (await state.storage.listUsageRecords(session.id)).filter(
      (item) => item.attemptId === msg.attemptId,
    );
    if (usageKindConflicts(after, msg.usage.kind))
      return { ok: false, error: "usage report kind conflicts with this attempt" };
    return { ok: true };
  }
  state.usageRecords.set(mapKey(record), record);
  return { ok: true };
}

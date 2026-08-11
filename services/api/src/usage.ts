import type { SessionUsage, UsageRates } from "@auto-harness/shared";

export type UsageRecord = SessionUsage & {
  sessionId: string;
  repositoryId: string;
  providerId?: string;
  providerAccountId?: string;
  commandId?: string;
  attemptId: string;
  worktreeId: string | null;
  receivedAt: string;
};

export type UsageAggregate = {
  sessionCount: number;
  reportCount: number;
  inputTokens: string;
  outputTokens: string;
  cachedInputTokens: string;
  reasoningTokens: string;
  totalTokens: string;
  costMicros: string;
  currency?: string;
  costMicrosByCurrency: Record<string, string>;
};

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "totalTokens",
  "costMicros",
] as const;
type NumericField = (typeof FIELDS)[number];

export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 30;
}

export function usageKindConflicts(records: UsageRecord[], kind: SessionUsage["kind"]): boolean {
  return records.some((record) => record.kind !== kind);
}

export function validateUsage(value: unknown): value is SessionUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  if (usage.kind !== "cumulative" && usage.kind !== "delta") return false;
  if (!Number.isSafeInteger(usage.sequence) || (usage.sequence as number) < 0) return false;
  if (
    usage.source !== "cli" ||
    typeof usage.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(usage.observedAt) ||
    Number.isNaN(Date.parse(usage.observedAt))
  )
    return false;
  if (usage.currency !== undefined && !/^[A-Z]{3}$/.test(usage.currency as string)) return false;
  return (
    FIELDS.some((field) => usage[field] !== undefined) &&
    FIELDS.every((field) => usage[field] === undefined || isDecimal(usage[field]))
  );
}

function add(a: string, b: string | undefined): string {
  if (!b) return a;
  return (BigInt(a) + BigInt(b)).toString();
}

function zeroAggregate(): UsageAggregate {
  return {
    sessionCount: 0,
    reportCount: 0,
    inputTokens: "0",
    outputTokens: "0",
    cachedInputTokens: "0",
    reasoningTokens: "0",
    totalTokens: "0",
    costMicros: "0",
    costMicrosByCurrency: {},
  };
}

/** Fold reports without trusting arrival order: deltas are deduped by key and
 * cumulative reports use the highest sequence for each attempt. */
export function aggregateUsage(records: UsageRecord[]): UsageAggregate {
  const aggregate = zeroAggregate();
  const bySession = new Set<string>();
  const deltas = new Set<string>();
  const deltaRecords: UsageRecord[] = [];
  const cumulative = new Map<string, UsageRecord>();
  const kinds = new Map<string, Set<SessionUsage["kind"]>>();
  for (const record of records) {
    bySession.add(record.sessionId);
    const key = `${record.sessionId}\0${record.attemptId}`;
    const kindSet = kinds.get(key) ?? new Set<SessionUsage["kind"]>();
    kindSet.add(record.kind);
    kinds.set(key, kindSet);
    if (record.kind === "delta") {
      const dedupe = `${key}\0${record.sequence}`;
      if (deltas.has(dedupe)) continue;
      deltas.add(dedupe);
      deltaRecords.push(record);
    } else {
      const previous = cumulative.get(key);
      if (!previous || record.sequence > previous.sequence) cumulative.set(key, record);
    }
  }
  const accepted: UsageRecord[] = [];
  for (const record of cumulative.values()) {
    accepted.push(record);
    aggregate.reportCount += 1;
    for (const field of FIELDS) aggregate[field] = add(aggregate[field], record[field]);
  }
  for (const record of deltaRecords) {
    const key = `${record.sessionId}\0${record.attemptId}`;
    if (kinds.get(key)?.has("cumulative")) continue;
    accepted.push(record);
    aggregate.reportCount += 1;
    for (const field of FIELDS) aggregate[field] = add(aggregate[field], record[field]);
  }
  aggregate.sessionCount = bySession.size;
  const byCurrency = new Map<string, string>();
  for (const record of accepted) {
    const currency = record.currency ?? "UNKNOWN";
    byCurrency.set(currency, add(byCurrency.get(currency) ?? "0", record.costMicros));
  }
  aggregate.costMicrosByCurrency = Object.fromEntries(byCurrency);
  const currencies = [...byCurrency.keys()];
  const onlyCurrency = currencies[0];
  if (currencies.length === 1 && onlyCurrency && onlyCurrency !== "UNKNOWN") {
    aggregate.currency = onlyCurrency;
  } else {
    aggregate.costMicros = "0";
  }
  return aggregate;
}

export function costFromRates(usage: SessionUsage, rates: UsageRates): string | undefined {
  let total = 0n;
  let seen = false;
  const pairs: [NumericField, string | undefined][] = [
    ["inputTokens", rates.inputTokenMicros],
    ["outputTokens", rates.outputTokenMicros],
    ["cachedInputTokens", rates.cachedInputTokenMicros],
    ["reasoningTokens", rates.reasoningTokenMicros],
  ];
  for (const [field, rate] of pairs) {
    if (usage[field] !== undefined && rate !== undefined) {
      total += BigInt(usage[field]!) * BigInt(rate);
      seen = true;
    }
  }
  return seen ? total.toString() : undefined;
}

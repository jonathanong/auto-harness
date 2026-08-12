export type UsageAggregate = {
  reportCount: number;
  inputTokens: string;
  outputTokens: string;
  totalTokens: string;
  costMicros: string;
  costMicrosByCurrency: Record<string, string>;
  currency?: string;
};

export function configuredCost(usage: UsageAggregate): string {
  const currencies = Object.entries(usage.costMicrosByCurrency);
  if (currencies.length > 1) {
    return currencies.map(([currency, cost]) => `${cost} ${currency} micros`).join(", ");
  }
  return `${usage.costMicros} ${usage.currency ? `${usage.currency} micros` : "micros"}`;
}

export function hasReportedUsage(usage: UsageAggregate | null): usage is UsageAggregate {
  return usage !== null && usage.reportCount > 0;
}

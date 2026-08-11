/** Provider-neutral, CLI-authoritative usage reported by a session. */
export type SessionUsage = {
  /** A CLI may send either a running total or an increment. */
  kind: "cumulative" | "delta";
  /** Monotonic sequence within one execution attempt. */
  sequence: number;
  /** Counts are decimal strings so large counters remain exact over JSON. */
  inputTokens?: string;
  outputTokens?: string;
  cachedInputTokens?: string;
  reasoningTokens?: string;
  totalTokens?: string;
  /** Operator-configured monetary amount in micros; never a vendor price lookup. */
  costMicros?: string;
  currency?: string;
  observedAt: string;
  /** Usage is accepted only when emitted by the CLI adapter, never inferred from logs. */
  source: "cli";
};

export type UsageRates = {
  inputTokenMicros?: string;
  outputTokenMicros?: string;
  cachedInputTokenMicros?: string;
  reasoningTokenMicros?: string;
  currency: string;
};

export function validateUsageRates(value: unknown): value is UsageRates {
  if (!value || typeof value !== "object") return false;
  const rates = value as Record<string, unknown>;
  return (
    typeof rates.currency === "string" &&
    /^[A-Z]{3}$/.test(rates.currency) &&
    [
      "inputTokenMicros",
      "outputTokenMicros",
      "cachedInputTokenMicros",
      "reasoningTokenMicros",
    ].every(
      (key) =>
        rates[key] === undefined ||
        (typeof rates[key] === "string" &&
          /^(0|[1-9][0-9]*)$/.test(rates[key] as string) &&
          (rates[key] as string).length <= 30),
    )
  );
}

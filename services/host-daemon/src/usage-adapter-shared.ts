import type { SessionUsage } from "@auto-harness/shared";

export const CLI_PROVIDERS = ["claude", "codex", "gemini", "grok"] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];

export type JsonRecord = Record<string, unknown>;

export type ParsedCliUsage = {
  usage?: SessionUsage;
  usageLimit?: boolean;
};

export function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function withUsage(usage: SessionUsage | undefined): ParsedCliUsage {
  return usage ? { usage } : {};
}

/** Read a CLI's own structured error code field. Never inspects model-authored content. */
export function structuredErrorCode(value: JsonRecord): string | undefined {
  const error = record(value.error);
  const code = error?.type ?? error?.code ?? error?.status;
  return typeof code === "string" ? code.toLowerCase() : undefined;
}

export function usageFromRecord(
  nested: JsonRecord,
  observedAt: string,
  provider: CliProvider,
): SessionUsage | undefined {
  const fields = usageFields(provider);
  const inputTokens = tokenString(nested, ...fields.input);
  const outputTokens = tokenString(nested, ...fields.output);
  // Grok's --output-format json usage object uses the same Anthropic-style split-cache
  // names as Claude (CLI 1.0.13 docs + #430 probe).
  const cachedInputTokens =
    provider === "claude" || provider === "grok"
      ? (sumTokenFields(nested, "cache_read_input_tokens", "cache_creation_input_tokens") ??
        tokenString(nested, ...fields.cached))
      : tokenString(nested, ...fields.cached);
  const reasoningTokens = tokenString(nested, ...fields.reasoning);
  const totalTokens = tokenString(nested, ...fields.total);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    kind: "cumulative",
    sequence: 0,
    source: "cli",
    observedAt,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function usageFields(provider: CliProvider): {
  input: string[];
  output: string[];
  cached: string[];
  reasoning: string[];
  total: string[];
} {
  if (provider === "gemini") {
    return {
      input: ["promptTokenCount", "inputTokens"],
      output: ["candidatesTokenCount", "outputTokens"],
      cached: ["cachedContentTokenCount", "cachedInputTokens"],
      reasoning: ["thoughtsTokenCount", "reasoningTokens"],
      total: ["totalTokenCount", "totalTokens"],
    };
  }
  return {
    input: ["input_tokens", "prompt_tokens", "inputTokens"],
    output: ["output_tokens", "completion_tokens", "outputTokens"],
    cached: ["cached_input_tokens", "cachedInputTokens"],
    reasoning: ["reasoning_tokens", "reasoningTokens"],
    total: ["total_tokens", "totalTokens"],
  };
}

function sumTokenFields(fields: JsonRecord, ...keys: string[]): string | undefined {
  let total = 0n;
  let found = false;
  for (const key of keys) {
    const value = tokenString(fields, key);
    if (value === undefined) continue;
    total += BigInt(value);
    found = true;
  }
  const rendered = total.toString();
  return found && rendered.length <= 30 ? rendered : undefined;
}

function tokenString(fields: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.trunc(value)).toString();
    }
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 30) {
      return value;
    }
  }
  return undefined;
}

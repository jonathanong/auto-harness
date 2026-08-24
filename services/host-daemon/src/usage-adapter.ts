import type { SessionUsage } from "@auto-harness/shared";

import type { ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
import { jsonObjects } from "./usage-adapter-json.ts";

const MAX_CAPTURE_BYTES = 256 * 1024;
const PROVIDERS = ["claude", "codex", "gemini", "grok"] as const;
type CliProvider = (typeof PROVIDERS)[number];

type ParsedCliUsage = {
  usage?: SessionUsage;
  usageLimit?: boolean;
};

export function executableStem(command: string | undefined): string {
  if (!command) return "";
  const normalized = command.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function resolveCliProvider(argv: readonly string[]): CliProvider | undefined {
  const stem = executableStem(argv[0]);
  return PROVIDERS.find((name) => name === stem);
}

/**
 * Extract CLI-authoritative usage from a provider-aware structured result.
 * Prompts and free-form logs are never inspected for token counts.
 */
export function parseCliUsage(input: {
  argv: readonly string[];
  output: string;
  observedAt: string;
}): ParsedCliUsage {
  if (!resolveCliProvider(input.argv)) return {};
  const objects = jsonObjects(input.output);
  let usage: SessionUsage | undefined;
  let usageLimit = false;
  for (const object of objects) {
    if (structuredUsageLimit(object)) usageLimit = true;
    const parsed = usageFromObject(object, input.observedAt);
    if (parsed) usage = parsed;
  }
  return {
    ...(usage ? { usage } : {}),
    ...(usageLimit ? { usageLimit: true } : {}),
  };
}

export class UsageCapturingProcessRunner implements ProcessRunner {
  readonly outputStreams?: "merged";
  private readonly inner: ProcessRunner;
  private readonly now: () => string;

  constructor(inner: ProcessRunner, now: () => string = () => new Date().toISOString()) {
    this.inner = inner;
    this.now = now;
    if (inner.outputStreams === "merged") this.outputStreams = "merged";
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    let captured = "";
    const result = await this.inner.run({
      ...options,
      onChunk: (chunk) => {
        captured = (captured + chunk.data).slice(-MAX_CAPTURE_BYTES);
        options.onChunk(chunk);
      },
    });
    const parsed = parseCliUsage({
      argv: options.argv,
      output: captured,
      observedAt: this.now(),
    });
    return {
      ...result,
      ...(result.usage === undefined && parsed.usage ? { usage: parsed.usage } : {}),
      ...(result.usageLimit === true || parsed.usageLimit ? { usageLimit: true } : {}),
    };
  }
}

function structuredUsageLimit(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = stringify(record.type ?? record.error_type ?? record.errorType);
  const error = record.error;
  const errorType =
    error && typeof error === "object"
      ? stringify((error as Record<string, unknown>).type)
      : stringify(error);
  const haystack = `${type} ${errorType} ${stringify(record.subtype)}`;
  return /rate[_ ]?limit|usage[_ ]?limit|insufficient_quota|resource_exhausted/i.test(haystack);
}

function usageFromObject(value: unknown, observedAt: string): SessionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const nested = firstUsageObject(record);
  if (!nested) return undefined;
  const inputTokens = tokenString(
    nested,
    "input_tokens",
    "prompt_tokens",
    "promptTokenCount",
    "inputTokens",
  );
  const outputTokens = tokenString(
    nested,
    "output_tokens",
    "completion_tokens",
    "candidatesTokenCount",
    "outputTokens",
  );
  const cachedInputTokens = tokenString(
    nested,
    "cache_read_input_tokens",
    "cached_input_tokens",
    "cachedContentTokenCount",
    "cachedInputTokens",
    "cache_creation_input_tokens",
  );
  const reasoningTokens = tokenString(
    nested,
    "reasoning_tokens",
    "thoughtsTokenCount",
    "reasoningTokens",
  );
  const totalTokens = tokenString(nested, "total_tokens", "totalTokens", "totalTokenCount");
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

function firstUsageObject(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["usage", "token_usage", "total_token_usage", "usageMetadata"]) {
    const candidate = record[key];
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  const payload = record.payload;
  if (payload && typeof payload === "object") {
    return firstUsageObject(payload as Record<string, unknown>);
  }
  const info = record.info;
  if (info && typeof info === "object") {
    return firstUsageObject(info as Record<string, unknown>);
  }
  return undefined;
}

function tokenString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return BigInt(Math.trunc(value)).toString();
    }
    if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 30) {
      return value;
    }
  }
  return undefined;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : "";
}

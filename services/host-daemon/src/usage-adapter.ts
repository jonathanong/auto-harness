/* eslint-disable max-lines -- provider envelope validation and token mapping must stay coupled. */
import type { SessionUsage } from "@auto-harness/shared";

import type { ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
import { jsonLines, jsonObject } from "./usage-adapter-json.ts";

// Structured provider envelopes may include a long response alongside the final usage block.
// Keep a bounded whole envelope rather than trimming its opening JSON delimiters.
const MAX_STRUCTURED_ENVELOPE_BYTES = 4 * 1024 * 1024;
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
  const provider = resolveCliProvider(input.argv);
  if (!provider || !hasStructuredOutputMode(provider, input.argv)) return {};
  if (provider === "codex") {
    return parseCodexRecords(jsonLines(input.output), input.observedAt);
  }
  const envelope = jsonObject(input.output);
  if (!envelope) return {};
  if (provider === "claude") return parseClaudeRecord(envelope, input.observedAt);
  if (provider === "gemini") return parseGeminiRecord(envelope, input.observedAt);
  return parseGrokRecord(envelope, input.observedAt);
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
    let capturedBytes = 0;
    let captureOverflowed = false;
    const provider = resolveCliProvider(options.argv);
    const captureStructuredOutput =
      provider !== undefined && hasStructuredOutputMode(provider, options.argv);
    const result = await this.inner.run({
      ...options,
      onChunk: (chunk) => {
        if (captureStructuredOutput && !captureOverflowed) {
          const chunkBytes = Buffer.byteLength(chunk.data);
          if (capturedBytes + chunkBytes > MAX_STRUCTURED_ENVELOPE_BYTES) {
            captured = "";
            captureOverflowed = true;
          } else {
            captured += chunk.data;
            capturedBytes += chunkBytes;
          }
        }
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

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function hasOption(argv: readonly string[], name: string, value?: string): boolean {
  return argv.some((arg, index) => {
    if (value !== undefined && arg === `${name}=${value}`) return true;
    return arg === name && (value === undefined || argv[index + 1] === value);
  });
}

function hasStructuredOutputMode(provider: CliProvider, argv: readonly string[]): boolean {
  switch (provider) {
    case "claude":
      return (
        (argv.includes("-p") || argv.includes("--print")) &&
        hasOption(argv, "--output-format", "json")
      );
    case "codex":
      return argv.includes("exec") && hasOption(argv, "--json");
    case "gemini":
      return (
        (argv.includes("-p") || argv.includes("--prompt")) &&
        hasOption(argv, "--output-format", "json")
      );
    case "grok":
      return (
        (argv.includes("-p") || argv.includes("--single")) &&
        hasOption(argv, "--output-format", "json")
      );
  }
}

function parseClaudeRecord(value: JsonRecord, observedAt: string): ParsedCliUsage {
  if (
    value.type !== "result" ||
    typeof value.subtype !== "string" ||
    typeof value.is_error !== "boolean"
  ) {
    return {};
  }
  const usage = record(value.usage);
  return {
    ...(usage ? withUsage(usageFromRecord(usage, observedAt, "claude")) : {}),
    ...(value.is_error && claudeUsageLimit(value) ? { usageLimit: true } : {}),
  };
}

function parseCodexRecords(values: JsonRecord[], observedAt: string): ParsedCliUsage {
  let parsed: ParsedCliUsage = {};
  for (const value of values) {
    if (value.type === "turn.completed") {
      const usage = record(value.usage);
      if (usage) parsed = { ...parsed, ...withUsage(usageFromRecord(usage, observedAt, "codex")) };
    }
    if (value.type === "turn.failed" && codexUsageLimit(value)) {
      parsed = { ...parsed, usageLimit: true };
    }
  }
  return parsed;
}

function parseGeminiRecord(value: JsonRecord, observedAt: string): ParsedCliUsage {
  if (geminiUsageLimit(value)) return { usageLimit: true };
  if (typeof value.response !== "string") return {};
  const stats = record(value.stats);
  const usage =
    record(value.usageMetadata) ?? record(stats?.usageMetadata) ?? record(stats?.tokens);
  return usage ? withUsage(usageFromRecord(usage, observedAt, "gemini")) : {};
}

function parseGrokRecord(value: JsonRecord, observedAt: string): ParsedCliUsage {
  if (grokUsageLimit(value)) return { usageLimit: true };
  if (typeof value.response !== "string" && typeof value.text !== "string") return {};
  const usage = record(value.usage);
  return usage ? withUsage(usageFromRecord(usage, observedAt, "grok")) : {};
}

function withUsage(usage: SessionUsage | undefined): ParsedCliUsage {
  return usage ? { usage } : {};
}

function structuredErrorCode(value: JsonRecord): string | undefined {
  const error = record(value.error);
  const code = error?.type ?? error?.code ?? error?.status;
  return typeof code === "string" ? code.toLowerCase() : undefined;
}

function claudeUsageLimit(value: JsonRecord): boolean {
  const code = structuredErrorCode(value) ?? value.subtype;
  return (
    typeof code === "string" && /^(?:rate_limit_error|usage_limit|insufficient_quota)$/.test(code)
  );
}

function codexUsageLimit(value: JsonRecord): boolean {
  const code = structuredErrorCode(value);
  return code === "insufficient_quota" || code === "rate_limit_error";
}

function geminiUsageLimit(value: JsonRecord): boolean {
  const error = record(value.error);
  return error?.status === "RESOURCE_EXHAUSTED" || error?.code === "RESOURCE_EXHAUSTED";
}

function grokUsageLimit(value: JsonRecord): boolean {
  if (value.type !== "error" && value.status !== "error") return false;
  const code = structuredErrorCode(value);
  return code === "rate_limit_error" || code === "usage_limit";
}

function usageFromRecord(
  nested: JsonRecord,
  observedAt: string,
  provider: CliProvider,
): SessionUsage | undefined {
  const fields = usageFields(provider);
  const inputTokens = tokenString(nested, ...fields.input);
  const outputTokens = tokenString(nested, ...fields.output);
  const cachedInputTokens =
    provider === "claude"
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

import {
  MAX_OUTPUT_CHUNK_BYTES,
  OUTPUT_CHUNK_TRUNCATION_MARKER,
  truncateUtf8,
  type OutputChunk,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from "./executor.ts";
import { createCodexUsageStream, parseCodexRecords } from "./usage-adapter-codex.ts";
import { jsonLines, jsonObject } from "./usage-adapter-json.ts";
import {
  CLI_PROVIDERS,
  record,
  structuredErrorCode,
  usageFromRecord,
  withUsage,
  type CliProvider,
  type JsonRecord,
  type ParsedCliUsage,
} from "./usage-adapter-shared.ts";

// Claude/Gemini/Grok's terminal result line can trail a long response; codex is folded
// incrementally instead (see usage-adapter-codex.ts) so this bound doesn't apply to it.
// Kept equal to usage-adapter-json.ts's own scan cap so jsonObject() never rejects the window.
const MAX_STRUCTURED_ENVELOPE_BYTES = 4 * 1024 * 1024;

export function executableStem(command: string | undefined): string {
  if (!command) return "";
  const normalized = command.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function resolveCliProvider(argv: readonly string[]): CliProvider | undefined {
  const stem = executableStem(argv[0]);
  return CLI_PROVIDERS.find((name) => name === stem);
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
    const provider = resolveCliProvider(options.argv);
    const captureStructuredOutput =
      provider !== undefined && hasStructuredOutputMode(provider, options.argv);
    // Captured once, before the process starts, rather than after completion as
    // before: codex's incremental fold needs a timestamp at fold time, and one
    // shared value per run keeps claude/gemini/grok's whole-buffer parse consistent
    // with it.
    const observedAt = this.now();
    const codexStream =
      captureStructuredOutput && provider === "codex"
        ? createCodexUsageStream(observedAt)
        : undefined;
    let captured = "";
    let capturedBytes = 0;
    const result = await this.inner.run({
      ...options,
      onChunk: (chunk) => {
        if (codexStream) {
          codexStream.push(chunk.data);
        } else if (captureStructuredOutput) {
          captured += chunk.data;
          capturedBytes += Buffer.byteLength(chunk.data);
          if (capturedBytes > MAX_STRUCTURED_ENVELOPE_BYTES) {
            captured = trailingWindow(captured, MAX_STRUCTURED_ENVELOPE_BYTES);
            // A trim can drop a partial codepoint, so recount instead of assuming.
            capturedBytes = Buffer.byteLength(captured, "utf8");
          }
        }
        forwardTruncated(chunk, options.onChunk);
      },
    });
    const parsed = codexStream
      ? codexStream.finish()
      : parseCliUsage({ argv: options.argv, output: captured, observedAt });
    return {
      ...result,
      ...(result.usage === undefined && parsed.usage ? { usage: parsed.usage } : {}),
      ...(result.usageLimit === true || parsed.usageLimit ? { usageLimit: true } : {}),
    };
  }
}

/**
 * `this.inner` may hand a single read whole (see `PtyProcessRunner`'s
 * `emitUntruncated`) so the capture step above sees complete data. Re-apply
 * `SpawnProcessRunner`'s own per-chunk byte cap here before forwarding, so the
 * downstream log/streamer keeps the same memory bound regardless of which
 * runner is wrapped. A chunk `this.inner` already truncated (or the marker
 * chunk itself) is at or under the cap and passes through unchanged.
 */
function forwardTruncated(chunk: OutputChunk, onChunk: (chunk: OutputChunk) => void): void {
  if (Buffer.byteLength(chunk.data, "utf8") <= MAX_OUTPUT_CHUNK_BYTES) {
    onChunk(chunk);
    return;
  }
  onChunk({ ...chunk, data: truncateUtf8(chunk.data, MAX_OUTPUT_CHUNK_BYTES) });
  onChunk({ stream: chunk.stream, data: OUTPUT_CHUNK_TRUNCATION_MARKER });
}

/**
 * Keep only the trailing `maxBytes` of a UTF-8 string. Callers only invoke this once the
 * value already exceeds `maxBytes`, so this always trims. Slicing a Buffer at a fixed byte
 * offset can bisect a multi-byte codepoint; the orphaned bytes decode to one or more U+FFFD,
 * which re-encode longer than the bytes they replaced. MAX_STRUCTURED_ENVELOPE_BYTES equals
 * jsonObject()'s own scan cap with zero headroom, so this must never return more than
 * `maxBytes` — stripping the leading replacement run (never real content jsonObject() would
 * scan for a literal `{` after) restores that guarantee instead of just hoping for it.
 */
function trailingWindow(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer
    .subarray(buffer.byteLength - maxBytes)
    .toString("utf8")
    .replace(/^�+/, "");
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

function claudeUsageLimit(value: JsonRecord): boolean {
  const code = structuredErrorCode(value) ?? value.subtype;
  if (
    typeof code === "string" &&
    /^(?:rate_limit_error|usage_limit|insufficient_quota)$/.test(code)
  ) {
    return true;
  }
  // Claude's own account-level 5h/weekly/model-specific plan quota is enforced client-side,
  // not as an Anthropic API error: the CLI reports it via this terminal_reason, with no
  // rate_limit_error/usage_limit code and no `error` object at all (subtype can still read
  // "success"). This is the exact shape of the real incident this detector must catch.
  return value.terminal_reason === "budget_exhausted";
}

const GEMINI_RESOURCE_EXHAUSTED = "RESOURCE_EXHAUSTED";
// Gemini CLI 0.46.0 `--output-format json` (JsonFormatter.formatError) emits
// `{error:{type, message, code?}}`. `code` is an exit code or the original
// error's `code`/`status`, not Google's RPC status. The RPC token
// RESOURCE_EXHAUSTED rides `error.message` when the CLI copies the API body
// (Gaxios/ApiError) or formats `(Status: RESOURCE_EXHAUSTED)`.
const GEMINI_RESOURCE_EXHAUSTED_IN_MESSAGE = /\bRESOURCE_EXHAUSTED\b/;

// Grok CLI 1.0.13 `--output-format json` errors are `{type:"error", message}`
// with no structured code. HTTP 429 is mapped to ACP -32003, then
// `format_rate_limited_user_message` writes one of these three sentences
// (unicode apostrophe). Curly apostrophe is what the binary emits; ASCII is
// tolerated the same way as Codex. A generic "rate limit" phrase is not enough.
const GROK_USAGE_LIMIT_SENTENCE =
  /you['’]ve (?:hit (?:the rate limit for your plan|your team['’]s api rate limit)|reached your free grok build usage limit)/i;

function geminiResourceExhausted(value: unknown): boolean {
  return value === GEMINI_RESOURCE_EXHAUSTED;
}

function geminiEnvelopeExhausted(error: JsonRecord): boolean {
  return geminiResourceExhausted(error.status) || geminiResourceExhausted(error.code);
}

function geminiUsageLimit(value: JsonRecord): boolean {
  const error = record(value.error);
  if (!error) return false;
  if (geminiEnvelopeExhausted(error)) return true;
  const nested = record(error.error);
  if (nested && geminiEnvelopeExhausted(nested)) return true;
  return (
    typeof error.message === "string" && GEMINI_RESOURCE_EXHAUSTED_IN_MESSAGE.test(error.message)
  );
}

function grokUsageLimit(value: JsonRecord): boolean {
  if (value.type !== "error" && value.status !== "error") return false;
  const code = structuredErrorCode(value);
  if (code === "rate_limit_error" || code === "usage_limit") return true;
  return typeof value.message === "string" && GROK_USAGE_LIMIT_SENTENCE.test(value.message);
}

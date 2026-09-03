const PROVIDERS = new Set(["claude", "codex", "gemini", "grok"]);

type UsageLimitMatch = "adapter";

type UsageLimitInput = {
  /** Trusted catalog argv from the assignment. Never prompt text. */
  argv: readonly string[];
  /** Non-zero/null exit. Success never classifies as a usage limit. */
  failed: boolean;
  /** Control-plane assignment account. Providerless commands fail closed. */
  providerAccountId?: string;
  /**
   * Adapter-supplied vendor quota. Sourced only from a CLI's own structured error envelope
   * (e.g. `error.type`/`code`/`status`, or Codex's own error-path message text) — never from
   * model/agent-generated content such as Codex's `item.*` records.
   */
  adapterUsageLimit?: boolean;
};

function executableStem(command: string | undefined): string {
  if (!command) return "";
  const normalized = command.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function hasKnownProvider(argv: readonly string[]): boolean {
  const stem = executableStem(argv[0]);
  return PROVIDERS.has(stem);
}

/**
 * Classify only a provider-aware adapter's structured limit signal. Prompt and
 * CLI output are untrusted, even for a catalog-owned executable.
 */
export function detectUsageLimit(input: UsageLimitInput): UsageLimitMatch | undefined {
  if (!input.failed) return undefined;
  if (!input.providerAccountId) return undefined;
  if (!hasKnownProvider(input.argv)) return undefined;
  return input.adapterUsageLimit === true ? "adapter" : undefined;
}

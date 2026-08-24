const PROVIDER_PATTERNS = {
  claude: [
    /rate_limit_error/i,
    /claude(?: ai)? usage limit/i,
    /you(?:'| ha)ve hit your (?:usage |monthly )?limit/i,
  ],
  codex: [
    /insufficient_quota/i,
    /you exceeded your current quota/i,
    /rate limit reached/i,
    /you(?:'| ha)ve hit your usage limit/i,
  ],
  gemini: [
    /resource_exhausted/i,
    /resource has been exhausted/i,
    /you exceeded your current quota/i,
    /quota exceeded for (?:quota )?metric/i,
  ],
  grok: [
    /rate limit error/i,
    /you(?:'| ha)ve reached your (?:usage |rate )?limit/i,
    /usage limit(?:s)? (?:reached|exceeded|hit)/i,
  ],
} as const;

type UsageLimitProvider = keyof typeof PROVIDER_PATTERNS;

type UsageLimitInput = {
  /** Trusted catalog argv from the assignment. Never prompt text. */
  argv: readonly string[];
  /** Non-zero/null exit. Success never classifies as a usage limit. */
  failed: boolean;
  /** Adapter-supplied vendor quota; never inferred from untrusted output. */
  adapterUsageLimit?: boolean;
  output: string;
};

function executableStem(command: string | undefined): string {
  if (!command) return "";
  const normalized = command.replaceAll("\\", "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

function resolveUsageLimitProvider(argv: readonly string[]): UsageLimitProvider | undefined {
  const stem = executableStem(argv[0]);
  if (Object.hasOwn(PROVIDER_PATTERNS, stem)) return stem as UsageLimitProvider;
  return undefined;
}

/**
 * Classify a vendor usage/rate limit from trusted catalog identity plus a
 * failure signal. Untrusted output text is never enough on its own.
 */
export function detectUsageLimit(input: UsageLimitInput): boolean {
  if (!input.failed) return false;
  const provider = resolveUsageLimitProvider(input.argv);
  if (provider === undefined) return false;
  if (input.adapterUsageLimit === true) return true;
  if (input.output.length === 0) return false;
  return PROVIDER_PATTERNS[provider].some((re) => re.test(input.output));
}

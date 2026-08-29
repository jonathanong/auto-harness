/** Operator-supplied per-token vendor rates; Auto Harness never fetches vendor prices. */
export type UsageRates = {
  inputTokenMicros?: string;
  outputTokenMicros?: string;
  cachedInputTokenMicros?: string;
  reasoningTokenMicros?: string;
  currency: string;
};

/** Global catalog entry: an AI CLI vendor, keyed by a unique, server-enforced `name`. */
export type Provider = {
  id: string;
  /** e.g. "claude", "codex", "grok" */
  name: string;
  defaultCommandId: string | null;
  createdAt: string;
  updatedAt: string;
  usageRates?: UsageRates;
};

/** Bounded literal-prefix policy used by the agent to extract a native resume reference. */
export type ResumeRefCapture = {
  stream: "stdout" | "stderr" | "either";
  linePrefix: string;
};

/** Global catalog entry: a named command invocation. New and renamed names are catalog-unique slugs. */
export type Command = {
  id: string;
  /** e.g. "claude-print", "echo-hello-world" */
  name: string;
  argv: string[];
  appendPrompt: boolean;
  appendPromptSeparator?: boolean;
  resumeArgvTemplate?: string[];
  resumeRefCapture?: ResumeRefCapture;
  /** FK to Provider, or null for a standalone command that runs anywhere ungated. */
  providerId: string | null;
  createdAt: string;
  updatedAt: string;
};

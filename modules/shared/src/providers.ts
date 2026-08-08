/** Global catalogs: AI CLI vendors, accounts of them, and named command invocations. */

export type Provider = {
  id: string;
  /** e.g. "claude", "codex", "grok" */
  name: string;
  /** FK to Command. Null only transiently — the UI creates this in the same step as the provider. */
  defaultCommandId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderAccount = {
  id: string;
  /** FK to Provider. */
  providerId: string;
  /** e.g. "jonathanrichardong@gmail.com" */
  label: string;
  createdAt: string;
  updatedAt: string;
};

export type Command = {
  id: string;
  /** e.g. "claude-print", "echo hello world" */
  name: string;
  /** Fixed argv prefix; never a shell string (D4). */
  argv: string[];
  /** When true, session prompt is appended as the final argv element. */
  appendPrompt: boolean;
  /** FK to Provider, or null for a standalone command that runs anywhere ungated. */
  providerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogCommandDefaults = {
  commandName: string;
  argv: string[];
  appendPrompt: boolean;
  appendPromptSeparator: boolean;
};

/**
 * Suggested default Command for a newly created Provider, keyed by the provider
 * name the operator typed. Grok's `-p`/`--single` takes the prompt as its option
 * value, so a `--` separator makes grok 1.0.5 exit 2.
 */
export function catalogCommandDefaults(name: string): CatalogCommandDefaults | null {
  const key = name.trim().toLowerCase();
  if (key === "grok") {
    return {
      commandName: "grok-print",
      argv: ["grok", "--always-approve", "--max-turns", "3", "-p"],
      appendPrompt: true,
      appendPromptSeparator: false,
    };
  }
  if (key === "claude") {
    return {
      commandName: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      appendPromptSeparator: true,
    };
  }
  return null;
}

/** True when the field is empty or still one of the catalog-suggested command names. */
export function isSuggestedCommandName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "grok-print" || trimmed === "claude-print";
}

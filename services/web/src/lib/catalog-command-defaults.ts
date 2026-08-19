type CatalogCommandDefaults = {
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
/** Normalized catalog key, or null when the name has no preset. */
export function catalogProviderKey(name: string): string | null {
  const key = name.trim().toLowerCase();
  return catalogCommandDefaults(name) ? key : null;
}

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

/** Keep a custom command name; only replace empty or catalog-suggested values. */
export function retainOrSuggestCommandName(current: string, suggested: string): string {
  return isSuggestedCommandName(current) ? suggested : current;
}

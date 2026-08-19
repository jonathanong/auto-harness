import { describe, expect, it } from "vitest";

import {
  catalogCommandDefaults,
  catalogProviderKey,
  isSuggestedCommandName,
  retainOrSuggestCommandName,
} from "./catalog-command-defaults.ts";

describe("catalogCommandDefaults", () => {
  it("returns grok -p defaults without a -- separator or --output-format plain", () => {
    expect(catalogCommandDefaults(" Grok ")).toEqual({
      commandName: "grok-print",
      argv: ["grok", "--always-approve", "--max-turns", "3", "-p"],
      appendPrompt: true,
      appendPromptSeparator: false,
    });
    expect(catalogCommandDefaults("grok")?.argv.includes("--output-format")).toBe(false);
  });

  it("returns claude -p defaults with a -- separator", () => {
    expect(catalogCommandDefaults("claude")).toEqual({
      commandName: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      appendPromptSeparator: true,
    });
  });

  it("returns null for unknown provider names", () => {
    expect(catalogCommandDefaults("codex")).toBeNull();
    expect(catalogCommandDefaults("")).toBeNull();
  });

  it("normalizes catalog keys so trailing spaces do not look like a new provider", () => {
    expect(catalogProviderKey(" Grok ")).toBe("grok");
    expect(catalogProviderKey("grok")).toBe("grok");
    expect(catalogProviderKey("codex")).toBeNull();
  });
});

describe("isSuggestedCommandName", () => {
  it("treats empty and catalog-generated names as replaceable", () => {
    expect(isSuggestedCommandName("")).toBe(true);
    expect(isSuggestedCommandName(" grok-print ")).toBe(true);
    expect(isSuggestedCommandName("claude-print")).toBe(true);
    expect(isSuggestedCommandName("my-print")).toBe(false);
  });

  it("replaces suggested names and keeps custom ones", () => {
    expect(retainOrSuggestCommandName("grok-print", "claude-print")).toBe("claude-print");
    expect(retainOrSuggestCommandName("my-cli", "claude-print")).toBe("my-cli");
  });
});

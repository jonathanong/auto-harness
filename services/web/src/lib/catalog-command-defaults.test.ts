import { describe, expect, it } from "vitest";

import {
  catalogCommandDefaults,
  catalogProviderKey,
  isSuggestedCommandName,
  retainOrSuggestCommandName,
} from "./catalog-command-defaults.ts";

describe("catalogCommandDefaults", () => {
  it("returns grok JSON defaults without a -- separator", () => {
    expect(catalogCommandDefaults(" Grok ")).toEqual({
      commandName: "grok-print",
      argv: ["grok", "--always-approve", "--max-turns", "3", "--output-format", "json", "-p"],
      appendPrompt: true,
      appendPromptSeparator: false,
    });
    expect(catalogCommandDefaults("grok")?.argv).toContain("--output-format");
  });

  it("returns Claude JSON defaults with a -- separator", () => {
    expect(catalogCommandDefaults("claude")).toEqual({
      commandName: "claude-print",
      argv: ["claude", "-p", "--output-format", "json"],
      appendPrompt: true,
      appendPromptSeparator: true,
    });
  });

  it("returns Codex JSON defaults with a -- separator", () => {
    expect(catalogCommandDefaults(" Codex ")).toEqual({
      commandName: "codex-exec",
      argv: ["codex", "exec", "--json"],
      appendPrompt: true,
      appendPromptSeparator: true,
    });
    expect(catalogCommandDefaults("codex")?.argv).toContain("--json");
  });

  it("returns the same cursor-agent --print --force defaults for cursor and cursor-agent", () => {
    const cursor = {
      commandName: "cursor-print",
      argv: ["cursor-agent", "--print", "--force"],
      appendPrompt: true,
      appendPromptSeparator: true,
    };
    expect(catalogCommandDefaults("cursor")).toEqual(cursor);
    expect(catalogCommandDefaults("cursor-agent")).toEqual(cursor);
    expect(catalogCommandDefaults("cursor")?.argv.includes("--output-format")).toBe(false);
  });

  it("returns null for unknown provider names", () => {
    expect(catalogCommandDefaults("other")).toBeNull();
    expect(catalogCommandDefaults("")).toBeNull();
  });

  it("normalizes catalog keys so trailing spaces do not look like a new provider", () => {
    expect(catalogProviderKey(" Grok ")).toBe("grok");
    expect(catalogProviderKey("grok")).toBe("grok");
    expect(catalogProviderKey("codex")).toBe("codex");
    expect(catalogProviderKey("cursor")).toBe("cursor");
    expect(catalogProviderKey("cursor-agent")).toBe("cursor");
    expect(catalogProviderKey("other")).toBeNull();
  });
});

describe("isSuggestedCommandName", () => {
  it("treats empty and catalog-generated names as replaceable", () => {
    expect(isSuggestedCommandName("")).toBe(true);
    expect(isSuggestedCommandName(" grok-print ")).toBe(true);
    expect(isSuggestedCommandName("claude-print")).toBe(true);
    expect(isSuggestedCommandName("codex-exec")).toBe(true);
    expect(isSuggestedCommandName("cursor-print")).toBe(true);
    expect(isSuggestedCommandName("my-print")).toBe(false);
  });

  it("replaces suggested names and keeps custom ones", () => {
    expect(retainOrSuggestCommandName("grok-print", "claude-print")).toBe("claude-print");
    expect(retainOrSuggestCommandName("codex-exec", "cursor-print")).toBe("cursor-print");
    expect(retainOrSuggestCommandName("my-cli", "claude-print")).toBe("my-cli");
  });
});

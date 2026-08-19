/** Suggested git worktree parent under the repo, keyed by scheduler label. */
export const VENDOR_WORKTREE_DIRS = {
  claude: ".claude/worktrees",
  grok: ".grok/worktrees",
  cursor: ".cursor/worktrees",
  "cursor-agent": ".cursor/worktrees",
  codex: ".codex/worktrees",
} as const;

/** Fallback when labels do not name a known vendor (e.g. `echo`). */
export const FALLBACK_WORKTREE_DIR = ".worktrees";

export type VendorWorktreeLabel = keyof typeof VENDOR_WORKTREE_DIRS;

export function vendorWorktreeDir(labels: readonly string[] = []): string {
  for (const label of labels) {
    const dir = VENDOR_WORKTREE_DIRS[label as VendorWorktreeLabel];
    if (dir) return dir;
  }
  return FALLBACK_WORKTREE_DIR;
}

/** Top-level directory names under the repo (`.claude`, `.worktrees`, …). */
export function vendorWorktreeRootNames(): string[] {
  const names = new Set<string>([FALLBACK_WORKTREE_DIR]);
  for (const dir of Object.values(VENDOR_WORKTREE_DIRS)) {
    const root = dir.split("/")[0];
    if (root) names.add(root);
  }
  return [...names].toSorted();
}

/**
 * Empirically verified non-interactive argv prefixes. Operators still create
 * Provider/Command catalog entries — these are recipes, not a seeded catalog.
 * Prompt is appended as the final argv element (`appendPrompt: true`).
 * Never pass Cursor's `--worktree`: Auto Harness already owns cwd/worktrees.
 */
export type CliRecipe = {
  providerName: string;
  commandName: string;
  argv: string[];
  appendPrompt: true;
  labels: string[];
};

export const CLI_RECIPES: readonly CliRecipe[] = [
  {
    providerName: "claude",
    commandName: "claude-print",
    argv: ["claude", "-p"],
    appendPrompt: true,
    labels: ["claude"],
  },
  {
    providerName: "codex",
    commandName: "codex-exec",
    argv: ["codex", "exec"],
    appendPrompt: true,
    labels: ["codex"],
  },
  {
    providerName: "grok",
    commandName: "grok-print",
    argv: ["grok", "--always-approve", "--max-turns", "3", "--output-format", "plain", "-p"],
    appendPrompt: true,
    labels: ["grok"],
  },
  {
    providerName: "cursor-agent",
    commandName: "cursor-agent-print",
    argv: ["cursor-agent", "-p", "--trust"],
    appendPrompt: true,
    labels: ["cursor-agent"],
  },
];

export function cliRecipeByProvider(name: string): CliRecipe | undefined {
  return CLI_RECIPES.find((recipe) => recipe.providerName === name);
}

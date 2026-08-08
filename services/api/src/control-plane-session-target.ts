import {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
} from "@auto-harness/shared";

import type { CommandRecord } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

export function buildProviderCatalog(state: ControlPlaneState): ProviderCatalog {
  return {
    providers: Object.fromEntries(state.providers),
    providerAccounts: Object.fromEntries(state.providerAccounts),
  };
}

/**
 * Resolve the final argv for a session against one candidate worktree, or `null` if
 * this worktree is not a valid assignment target. Standalone commands
 * (`session.commandId`) are ungated and resolve the same everywhere. Provider-account
 * sessions walk the worktree -> repository -> host -> provider-default cascade
 * (`@auto-harness/shared`'s provider-cascade.ts) and are gated by enablement — a
 * disabled or unresolvable account means this worktree isn't a valid target, and the
 * caller should try the next candidate rather than assign here.
 *
 * This is the single place both the scheduler (which candidate worktrees are even
 * eligible) and the assign message (what argv to send) resolve from, so scheduling
 * and spawning can never disagree.
 */
export function resolveSessionTargetArgv(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
): string[] | null {
  if (session.commandId !== undefined) {
    return buildArgv(state.commands.get(session.commandId), session.prompt);
  }
  if (session.providerAccountId === undefined) {
    return null;
  }
  const host = state.agentHosts.get(worktree.agentId);
  const hostRepo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = hostRepo?.worktrees.find((w) => w.id === worktree.id);
  if (!resolveProviderAccountEnabled(session.providerAccountId, hostWorktree, hostRepo, host)) {
    return null;
  }
  const commandId = resolveProviderAccountCommandId(
    session.providerAccountId,
    hostWorktree,
    hostRepo,
    host,
    catalog,
  );
  if (!commandId) {
    return null;
  }
  return buildArgv(state.commands.get(commandId), session.prompt);
}

function buildArgv(command: CommandRecord | undefined, prompt: string): string[] | null {
  if (!command || command.argv.length === 0) {
    return null;
  }
  return command.appendPrompt ? [...command.argv, prompt] : [...command.argv];
}

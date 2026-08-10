import {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
} from "@auto-harness/shared";
import type { SessionResumeSpec } from "@auto-harness/shared";

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
  return resolveSessionTarget(state, catalog, session, worktree)?.resolvedArgv ?? null;
}

type ResolvedSessionTarget = {
  resolvedArgv: string[];
  resumeSpec: SessionResumeSpec;
};

export function resolveSessionTarget(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
): ResolvedSessionTarget | null {
  let commandId: string | undefined;
  if (session.commandId !== undefined) {
    commandId = session.commandId;
  } else {
    if (session.providerAccountId === undefined) return null;
    const host = state.hostInventories.get(worktree.hostId);
    const hostRepo = host?.repositories.find((r) => r.id === worktree.repositoryId);
    const hostWorktree = hostRepo?.worktrees.find((w) => w.id === worktree.id);
    if (!resolveProviderAccountEnabled(session.providerAccountId, hostWorktree, hostRepo, host)) {
      return null;
    }
    commandId = resolveProviderAccountCommandId(
      session.providerAccountId,
      hostWorktree,
      hostRepo,
      host,
      catalog,
    );
    if (!commandId) return null;
  }
  const command = state.commands.get(commandId);
  if (!command) return null;
  const resolvedArgv = buildArgv(command, session.prompt);
  return resolvedArgv
    ? {
        resolvedArgv,
        resumeSpec: {
          argv: [...command.argv],
          appendPrompt: command.appendPrompt,
          ...(command.resumeArgvTemplate !== undefined
            ? { resumeArgvTemplate: [...command.resumeArgvTemplate] }
            : {}),
          ...(command.resumeRefCapture !== undefined
            ? { resumeRefCapture: { ...command.resumeRefCapture } }
            : {}),
        },
      }
    : null;
}

function buildArgv(command: CommandRecord, prompt: string): string[] | null {
  if (command.argv.length === 0) {
    return null;
  }
  return command.appendPrompt ? [...command.argv, prompt] : [...command.argv];
}

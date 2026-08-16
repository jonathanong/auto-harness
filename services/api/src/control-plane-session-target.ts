/* eslint-disable max-lines */
import {
  materializeResumeArgv,
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
  type SessionResumeSpec,
  type TargetRef,
} from "@auto-harness/shared";

import type { CommandRecord } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

type ResolvedSessionRoute = {
  targetIndex: number;
  providerAccountId?: string;
  commandId: string;
  resolvedArgv: string[];
  resumeSpec: SessionResumeSpec;
};

export function buildProviderCatalog(state: ControlPlaneState): ProviderCatalog {
  return {
    providers: Object.fromEntries(state.providers),
    providerAccounts: Object.fromEntries(state.providerAccounts),
  };
}

/** Resolve one worktree against the ordered route policy. */
export function resolveSessionTargetRoute(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
): ResolvedSessionRoute | null {
  const targets = [session.target, ...session.fallbacks];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    if (session.suppressedTargetIndexes?.includes(targetIndex)) continue;
    const target = targets[targetIndex]!;
    const route = resolveTarget(
      state,
      catalog,
      target,
      session.prompt,
      worktree,
      nowMs,
      session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
    );
    if (route && matchesNativeResumePin(session, { ...route, targetIndex })) {
      return { ...route, targetIndex };
    }
  }
  return null;
}

/** Resolve one explicit policy entry. Scheduler uses this to exhaust each target before fallbacks. */
export function resolveSessionTargetRouteAt(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
  targetIndex: number,
): ResolvedSessionRoute | null {
  if (session.suppressedTargetIndexes?.includes(targetIndex)) return null;
  const target = [session.target, ...session.fallbacks][targetIndex];
  if (!target) return null;
  const route = resolveTarget(
    state,
    catalog,
    target,
    session.prompt,
    worktree,
    nowMs,
    session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
  );
  const resolved = route
    ? { ...route, targetIndex }
    : resolveNativeResumeRoute(state, catalog, session, worktree, nowMs, targetIndex);
  return resolved && matchesNativeResumePin(session, resolved) ? resolved : null;
}

/** A pinned continuation can use its frozen command snapshot after catalog edits. */
function resolveNativeResumeRoute(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
  targetIndex: number,
): ResolvedSessionRoute | null {
  const spec = session.resumeSpec;
  if (
    !session.resumedFromSessionId ||
    !spec ||
    (!session.cliResumeRef && !session.resumeFallback) ||
    session.pinnedTargetIndex !== targetIndex ||
    session.pinnedCommandId === undefined
  ) {
    return null;
  }
  const host = state.hostInventories.get(worktree.hostId);
  const repository = host?.repositories.find((item) => item.id === worktree.repositoryId);
  const hostWorktree = repository?.worktrees.find((item) => item.id === worktree.id);
  const accountId = session.pinnedProviderAccountId ?? undefined;
  if (accountId) {
    const account = state.providerAccounts.get(accountId);
    if (
      !account ||
      (account.usageLimitedUntil && Date.parse(account.usageLimitedUntil) > nowMs) ||
      !resolveProviderAccountEnabled(accountId, hostWorktree, repository, host)
    ) {
      return null;
    }
  }
  if (spec.resumeArgvTemplate && !session.cliResumeRef) return null;
  return {
    targetIndex,
    commandId: session.pinnedCommandId,
    ...(accountId ? { providerAccountId: accountId } : {}),
    resolvedArgv: spec.resumeArgvTemplate
      ? materializeResumeArgv(
          spec.resumeArgvTemplate,
          session.cliResumeRef!,
          session.prompt,
          spec.appendPromptSeparator,
        )
      : // Same opt-in `--` separator as buildArgv, for the same reason.
        !spec.appendPrompt
        ? [...spec.argv]
        : spec.appendPromptSeparator
          ? [...spec.argv, "--", session.prompt]
          : [...spec.argv, session.prompt],
    resumeSpec: copyResumeSpec(spec),
  };
}

/** A CLI resume is valid only on precisely the route that produced its ref. */
function matchesNativeResumePin(session: SessionRecord, route: ResolvedSessionRoute): boolean {
  if (!session.pinnedHostId) return true;
  if (session.pinnedTargetIndex !== undefined && session.pinnedTargetIndex !== route.targetIndex) {
    return false;
  }
  if (session.pinnedCommandId !== undefined && session.pinnedCommandId !== route.commandId) {
    return false;
  }
  return (
    !session.pinnedProviderAccountId || session.pinnedProviderAccountId === route.providerAccountId
  );
}

/** Kept as a narrow compatibility helper for daemon-facing execution code. */
export function resolveSessionTargetArgv(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
): string[] | null {
  return (
    resolveSessionTargetRoute(state, catalog, session, worktree, Date.parse(state.now()))
      ?.resolvedArgv ?? null
  );
}

function resolveTarget(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  target: TargetRef,
  prompt: string,
  worktree: WorktreeRecord,
  nowMs: number,
  pinnedProviderAccountId: string | null | undefined,
): Omit<ResolvedSessionRoute, "targetIndex"> | null {
  if ("commandId" in target) {
    const command = state.commands.get(target.commandId);
    if (!command) return null;
    if (command.providerId === null) {
      const resolvedArgv = buildArgv(command, prompt);
      return resolvedArgv
        ? { commandId: command.id, resolvedArgv, resumeSpec: commandResumeSpec(command) }
        : null;
    }
    const account = resolveEligibleAccounts(
      state,
      catalog,
      command.providerId,
      worktree,
      nowMs,
      pinnedProviderAccountId,
    )[0];
    const resolvedArgv = buildArgv(command, prompt);
    return account && resolvedArgv
      ? {
          providerAccountId: account.id,
          commandId: command.id,
          resolvedArgv,
          resumeSpec: commandResumeSpec(command),
        }
      : null;
  }
  const host = state.hostInventories.get(worktree.hostId);
  const repo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = repo?.worktrees.find((w) => w.id === worktree.id);
  for (const account of resolveEligibleAccounts(
    state,
    catalog,
    target.providerId,
    worktree,
    nowMs,
    pinnedProviderAccountId,
  )) {
    const commandId = resolveProviderAccountCommandId(
      account.id,
      hostWorktree,
      repo,
      host,
      catalog,
    );
    const command = commandId ? state.commands.get(commandId) : undefined;
    const resolvedArgv = buildArgv(command, prompt);
    if (resolvedArgv && commandId && command) {
      return {
        providerAccountId: account.id,
        commandId,
        resolvedArgv,
        resumeSpec: commandResumeSpec(command),
      };
    }
  }
  return null;
}

function resolveEligibleAccounts(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  providerId: string,
  worktree: WorktreeRecord,
  nowMs: number,
  pinnedProviderAccountId: string | null | undefined,
) {
  const host = state.hostInventories.get(worktree.hostId);
  const repo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = repo?.worktrees.find((w) => w.id === worktree.id);
  return [...state.providerAccounts.values()]
    .filter((account) => account.providerId === providerId)
    .filter((account) => !pinnedProviderAccountId || account.id === pinnedProviderAccountId)
    .filter(
      (account) => !account.usageLimitedUntil || Date.parse(account.usageLimitedUntil) <= nowMs,
    )
    .filter((account) => resolveProviderAccountEnabled(account.id, hostWorktree, repo, host))
    .toSorted(
      (a, b) =>
        (a.lastAssignedAt ?? "").localeCompare(b.lastAssignedAt ?? "") || a.id.localeCompare(b.id),
    );
}

/** Resolve a scheduled run against a host's main checkout, never a worktree. */
export function resolveScheduledSessionTarget(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  hostId: string,
): ResolvedSessionRoute | null {
  const host = state.hostInventories.get(hostId);
  const repository = host?.repositories.find((entry) => entry.id === session.repositoryId);
  if (!host || !repository) return null;
  // A scheduled run is deliberately resolved against the repository itself,
  // rather than an arbitrary worktree. The synthetic id cannot match a
  // worktree override, so provider account selection still honors account,
  // repository, and host configuration while ignoring worktree-only policy.
  const mainCheckout: WorktreeRecord = {
    id: `main-checkout:${hostId}:${session.repositoryId}`,
    name: "main checkout",
    hostId,
    repositoryId: session.repositoryId,
    path: repository.path,
    labels: [],
    status: "idle",
    online: true,
  };
  const targets = [session.target, ...session.fallbacks];
  const nowMs = Date.parse(state.now());
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    if (session.suppressedTargetIndexes?.includes(targetIndex)) continue;
    const route = resolveTarget(
      state,
      catalog,
      targets[targetIndex]!,
      session.prompt,
      mainCheckout,
      nowMs,
      session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
    );
    if (route && matchesNativeResumePin(session, { ...route, targetIndex })) {
      return { ...route, targetIndex };
    }
  }
  return null;
}

function buildArgv(command: CommandRecord | undefined, prompt: string): string[] | null {
  if (!command || command.argv.length === 0) return null;
  if (!command.appendPrompt) return [...command.argv];
  // `--` only neutralizes a leading-dash prompt for getopt-style executables that treat it
  // as "end of options" — some commands (e.g. `printf "%s"`) instead read it as literal
  // data, breaking the one-argument contract. So it's opt-in per Command, not automatic.
  return command.appendPromptSeparator
    ? [...command.argv, "--", prompt]
    : [...command.argv, prompt];
}

function commandResumeSpec(command: CommandRecord): SessionResumeSpec {
  return {
    argv: [...command.argv],
    appendPrompt: command.appendPrompt,
    appendPromptSeparator: command.appendPromptSeparator,
    ...(command.resumeArgvTemplate ? { resumeArgvTemplate: [...command.resumeArgvTemplate] } : {}),
    ...(command.resumeRefCapture ? { resumeRefCapture: { ...command.resumeRefCapture } } : {}),
  };
}

function copyResumeSpec(spec: SessionResumeSpec): SessionResumeSpec {
  return {
    argv: [...spec.argv],
    appendPrompt: spec.appendPrompt,
    appendPromptSeparator: spec.appendPromptSeparator,
    ...(spec.resumeArgvTemplate ? { resumeArgvTemplate: [...spec.resumeArgvTemplate] } : {}),
    ...(spec.resumeRefCapture ? { resumeRefCapture: { ...spec.resumeRefCapture } } : {}),
  };
}

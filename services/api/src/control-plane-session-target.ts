/* eslint-disable max-lines */
import {
  materializeResumeArgv,
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  validateCommandResumeSpec,
  type ProviderCatalog,
  type SessionResumeSpec,
  type TargetRef,
} from "@auto-harness/shared";

import type { CommandRecord } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

export type ResolvedSessionRoute = {
  targetIndex: number;
  providerId?: string;
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
  const providerId = accountId ? catalog.providerAccounts[accountId]?.providerId : undefined;
  const argv = providerId ? migrateLegacyProviderArgv(spec.argv) : [...spec.argv];
  const resumeArgvTemplate =
    spec.resumeArgvTemplate === undefined
      ? undefined
      : providerId
        ? migrateLegacyProviderArgv(spec.resumeArgvTemplate)
        : [...spec.resumeArgvTemplate];
  let validatedResumeArgvTemplate = resumeArgvTemplate;
  if (resumeArgvTemplate !== undefined) {
    const validation = validateCommandResumeSpec({ resumeArgvTemplate });
    if (!validation.ok) return null;
    validatedResumeArgvTemplate = validation.value.resumeArgvTemplate;
  }
  return {
    targetIndex,
    commandId: session.pinnedCommandId,
    ...(providerId !== undefined ? { providerId } : {}),
    ...(accountId ? { providerAccountId: accountId } : {}),
    resolvedArgv: validatedResumeArgvTemplate
      ? materializeResumeArgv(
          validatedResumeArgvTemplate,
          session.cliResumeRef!,
          session.prompt,
          spec.appendPromptSeparator,
        )
      : // Same opt-in `--` separator as buildArgv, for the same reason.
        !spec.appendPrompt
        ? argv
        : spec.appendPromptSeparator
          ? [...argv, "--", session.prompt]
          : [...argv, session.prompt],
    resumeSpec: copyResumeSpec(spec, argv, validatedResumeArgvTemplate),
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

function resolveTargets(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  target: TargetRef,
  prompt: string,
  worktree: WorktreeRecord,
  nowMs: number,
  pinnedProviderAccountId: string | null | undefined,
): Array<Omit<ResolvedSessionRoute, "targetIndex">> {
  if ("commandId" in target) {
    const command = state.commands.get(target.commandId);
    if (!command) return [];
    const providerId = command.providerId;
    if (providerId === null) {
      const resolvedArgv = buildArgv(command, prompt, false);
      return resolvedArgv
        ? [{ commandId: command.id, resolvedArgv, resumeSpec: commandResumeSpec(command, false) }]
        : [];
    }
    const resolvedArgv = buildArgv(command, prompt, true);
    if (!resolvedArgv) return [];
    return resolveEligibleAccounts(
      state,
      catalog,
      providerId,
      worktree,
      nowMs,
      pinnedProviderAccountId,
    ).map((account) => ({
      providerId,
      providerAccountId: account.id,
      commandId: command.id,
      resolvedArgv,
      resumeSpec: commandResumeSpec(command, true),
    }));
  }
  const host = state.hostInventories.get(worktree.hostId);
  const repo = host?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = repo?.worktrees.find((w) => w.id === worktree.id);
  const routes: Array<Omit<ResolvedSessionRoute, "targetIndex">> = [];
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
    // This route is account-bound even if an older catalog row has a mismatched
    // providerId, so it still needs a structured provider envelope for usage routing.
    const resolvedArgv = buildArgv(command, prompt, true);
    if (resolvedArgv && commandId && command) {
      routes.push({
        providerId: target.providerId,
        providerAccountId: account.id,
        commandId,
        resolvedArgv,
        resumeSpec: commandResumeSpec(command, true),
      });
    }
  }
  return routes;
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
  return (
    resolveTargets(state, catalog, target, prompt, worktree, nowMs, pinnedProviderAccountId)[0] ??
    null
  );
}

/** Resolve every eligible account for one policy entry, in lastAssignedAt order. */
export function resolveSessionTargetRoutesAt(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktree: WorktreeRecord,
  nowMs: number,
  targetIndex: number,
): ResolvedSessionRoute[] {
  if (session.suppressedTargetIndexes?.includes(targetIndex)) return [];
  const target = [session.target, ...session.fallbacks][targetIndex];
  if (!target) return [];
  const routes = resolveTargets(
    state,
    catalog,
    target,
    session.prompt,
    worktree,
    nowMs,
    session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
  ).map((route) => ({ ...route, targetIndex }));
  if (routes.length === 0) {
    const native = resolveNativeResumeRoute(state, catalog, session, worktree, nowMs, targetIndex);
    return native && matchesNativeResumePin(session, native) ? [native] : [];
  }
  return routes.filter((route) => matchesNativeResumePin(session, route));
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
export function resolveScheduledSessionTargets(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  hostId: string,
): ResolvedSessionRoute[] {
  const host = state.hostInventories.get(hostId);
  const repository = host?.repositories.find((entry) => entry.id === session.repositoryId);
  if (!host || !repository) return [];
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
  const routes: ResolvedSessionRoute[] = [];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    if (session.suppressedTargetIndexes?.includes(targetIndex)) continue;
    for (const route of resolveTargets(
      state,
      catalog,
      targets[targetIndex]!,
      session.prompt,
      mainCheckout,
      nowMs,
      session.pinnedHostId ? session.pinnedProviderAccountId : undefined,
    )) {
      const resolved = { ...route, targetIndex };
      if (matchesNativeResumePin(session, resolved)) routes.push(resolved);
    }
  }
  return routes;
}

export function resolveScheduledSessionTarget(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  hostId: string,
): ResolvedSessionRoute | null {
  return resolveScheduledSessionTargets(state, catalog, session, hostId)[0] ?? null;
}

function buildArgv(
  command: CommandRecord | undefined,
  prompt: string,
  providerBound: boolean,
): string[] | null {
  if (!command || command.argv.length === 0) return null;
  const argv = providerBound ? migrateLegacyProviderArgv(command.argv) : [...command.argv];
  if (!command.appendPrompt) return argv;
  // `--` only neutralizes a leading-dash prompt for getopt-style executables that treat it
  // as "end of options" — some commands (e.g. `printf "%s"`) instead read it as literal
  // data, breaking the one-argument contract. So it's opt-in per Command, not automatic.
  return command.appendPromptSeparator ? [...argv, "--", prompt] : [...argv, prompt];
}

/**
 * Compatibility-upgrade pre-existing provider commands at dispatch. The catalog remains
 * operator-authored: explicit format flags and custom executables are never rewritten.
 */
function migrateLegacyProviderArgv(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  const optionEnd = separator < 0 ? argv.length : separator;
  const optionArgv = argv.slice(0, optionEnd);
  const executable = executableStem(optionArgv[0]);
  if (executable === "codex") {
    if (hasOption(optionArgv, "--json")) return [...argv];
    const execIndex = optionArgv.indexOf("exec");
    return execIndex < 0 ? [...argv] : insertArgs(argv, execIndex + 1, ["--json"]);
  }
  if (hasOption(optionArgv, "--output-format")) return [...argv];
  const promptIndex = optionArgv.findIndex((arg) => {
    if (executable === "claude") return arg === "-p" || arg === "--print";
    if (executable === "gemini") return arg === "-p" || arg === "--prompt";
    return executable === "grok" && (arg === "-p" || arg === "--single");
  });
  if (promptIndex < 0) return [...argv];
  // Gemini and Grok prompt switches consume their following value, so the format pair must
  // precede them. Claude accepts the same order and keeps this migration uniform.
  return insertArgs(argv, promptIndex, ["--output-format", "json"]);
}

function executableStem(value: string | undefined): string {
  if (!value) return "";
  const normalized = value.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return basename.replace(/\.(?:exe|cmd|bat)$/iu, "").toLowerCase();
}

function hasOption(argv: readonly string[], option: string): boolean {
  return argv.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function insertArgs(argv: readonly string[], index: number, args: readonly string[]): string[] {
  return [...argv.slice(0, index), ...args, ...argv.slice(index)];
}

function commandResumeSpec(command: CommandRecord, providerBound: boolean): SessionResumeSpec {
  const argv = providerBound ? migrateLegacyProviderArgv(command.argv) : [...command.argv];
  const resumeArgvTemplate =
    command.resumeArgvTemplate === undefined
      ? undefined
      : providerBound
        ? migrateLegacyProviderArgv(command.resumeArgvTemplate)
        : [...command.resumeArgvTemplate];
  return {
    argv,
    appendPrompt: command.appendPrompt,
    appendPromptSeparator: command.appendPromptSeparator,
    ...(resumeArgvTemplate ? { resumeArgvTemplate } : {}),
    ...(command.resumeRefCapture ? { resumeRefCapture: { ...command.resumeRefCapture } } : {}),
  };
}

function copyResumeSpec(
  spec: SessionResumeSpec,
  argv: readonly string[] = spec.argv,
  resumeArgvTemplate: readonly string[] | undefined = spec.resumeArgvTemplate,
): SessionResumeSpec {
  return {
    argv: [...argv],
    appendPrompt: spec.appendPrompt,
    appendPromptSeparator: spec.appendPromptSeparator,
    ...(resumeArgvTemplate ? { resumeArgvTemplate: [...resumeArgvTemplate] } : {}),
    ...(spec.resumeRefCapture ? { resumeRefCapture: { ...spec.resumeRefCapture } } : {}),
  };
}

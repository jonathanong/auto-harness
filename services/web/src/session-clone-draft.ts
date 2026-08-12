import type { SessionTarget, SessionTargetSelection } from "./session-target.ts";

export type SessionCloneSource = {
  repositoryId?: string | null;
  prompt?: string | null;
  target?: { providerId?: string; commandId?: string } | null;
  fallbacks?: Array<{ providerId?: string; commandId?: string }> | null;
  queueTtlSeconds?: number | null;
  timeout?: number | null;
  priority?: number | null;
  requiredLabels?: string[] | null;
  ref?: string | null;
};

export type SessionCloneDraft = {
  repositoryId: string;
  prompt: string;
  target: SessionTargetSelection;
  fallbacks: SessionTargetSelection[];
  queueTtlSeconds: number;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  ref?: string;
};

export function cloneSourceId(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

/** Copy only fields accepted by a fresh create; runtime, concurrency, resume, and metadata stay out. */
export function sessionCloneDraft(source: SessionCloneSource): SessionCloneDraft | null {
  const target = targetSelection(source.target);
  if (typeof source.repositoryId !== "string" || typeof source.prompt !== "string" || !target) {
    return null;
  }
  return {
    repositoryId: source.repositoryId,
    prompt: source.prompt,
    target,
    fallbacks: (source.fallbacks ?? [])
      .map(targetSelection)
      .filter((selection): selection is SessionTargetSelection => selection !== null),
    queueTtlSeconds: source.queueTtlSeconds ?? 691_200,
    timeout: source.timeout ?? 600,
    priority: source.priority ?? 0,
    requiredLabels: [...(source.requiredLabels ?? [])],
    ...(source.ref ? { ref: source.ref } : {}),
  };
}

export function includeDraftTargets(
  targets: SessionTarget[],
  draft: SessionCloneDraft | null,
): SessionTarget[] {
  if (!draft) return targets;
  const result = [...targets];
  for (const selection of [draft.target, ...draft.fallbacks]) {
    const kind = "providerId" in selection ? "provider" : "command";
    const id = "providerId" in selection ? selection.providerId : selection.commandId;
    if (!result.some((target) => target.kind === kind && target.id === id)) {
      result.push({ kind, id, label: `Unavailable ${kind} ${id}`, available: false });
    }
  }
  return result;
}

function targetSelection(
  target: { providerId?: string; commandId?: string } | null | undefined,
): SessionTargetSelection | null {
  if (!target) return null;
  if (target.providerId && !target.commandId) return { providerId: target.providerId };
  if (target.commandId && !target.providerId) return { commandId: target.commandId };
  return null;
}

import type { HostWireMessage, SessionAssign } from "@auto-harness/shared";

type AssignMessage = Extract<HostWireMessage, { type: "session:assign" }>;

/** Non-secret routing breadcrumbs for logs and diagnostics only. */
type ResolvedRouteMetadata = Pick<SessionAssign, "targetIndex" | "commandId" | "providerAccountId">;

export function resolvedRouteMetadata(message: AssignMessage): ResolvedRouteMetadata {
  return {
    ...(message.targetIndex !== undefined ? { targetIndex: message.targetIndex } : {}),
    ...(message.commandId !== undefined ? { commandId: message.commandId } : {}),
    ...(message.providerAccountId !== undefined
      ? { providerAccountId: message.providerAccountId }
      : {}),
  };
}

/** Convert the wire payload to the runner input without widening optional fields. */
export function sessionAssignFromWire(message: AssignMessage): SessionAssign {
  const route = resolvedRouteMetadata(message);
  return {
    sessionId: message.sessionId,
    ...(message.sessionType !== undefined ? { sessionType: message.sessionType } : {}),
    attemptId: message.attemptId,
    repositoryId: message.repositoryId,
    prompt: message.prompt,
    resolvedArgv: message.resolvedArgv,
    timeout: message.timeout,
    worktreeId: message.worktreeId,
    ...(message.ref !== undefined ? { ref: message.ref } : {}),
    ...(message.setupScript !== undefined ? { setupScript: message.setupScript } : {}),
    ...(message.resume !== undefined ? { resume: message.resume } : {}),
    ...(message.resumedFromSessionId !== undefined
      ? { resumedFromSessionId: message.resumedFromSessionId }
      : {}),
    ...(message.cliResumeRef !== undefined ? { cliResumeRef: message.cliResumeRef } : {}),
    ...(message.resumeRefCapture !== undefined
      ? { resumeRefCapture: message.resumeRefCapture }
      : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    // Route metadata is intentionally informational.  It is not consulted by
    // SessionRunner, which always spawns the scheduler-provided resolvedArgv.
    ...(route.targetIndex !== undefined ? { targetIndex: route.targetIndex } : {}),
    ...(route.commandId !== undefined ? { commandId: route.commandId } : {}),
    ...(route.providerAccountId !== undefined
      ? { providerAccountId: route.providerAccountId }
      : {}),
  };
}

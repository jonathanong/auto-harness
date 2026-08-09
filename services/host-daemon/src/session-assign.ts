import type { HostWireMessage, SessionAssign } from "@auto-harness/shared";

type AssignMessage = Extract<HostWireMessage, { type: "session:assign" }>;

/** Convert the wire payload to the runner input without widening optional fields. */
export function sessionAssignFromWire(message: AssignMessage): SessionAssign {
  return {
    sessionId: message.sessionId,
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
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  };
}

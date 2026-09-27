export const ASSIGNMENT_REPORTING_BUDGET_MS = 2_000;
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

/** No host assignment (and hence no repository setup/hook) precedes a fresh online write/readback. */
export async function assignmentReportingAllowed(
  state: ControlPlaneState,
  session: SessionRecord,
  attemptId: string,
): Promise<boolean> {
  let allowed = false;
  try {
    allowed =
      (!state.blackboardReporting?.requiresDurableStorage || Boolean(state.storage)) &&
      (await state.blackboardReporting?.authorizeAssignment(session, attemptId)) === true;
  } catch {
    /* Admission fails closed. */
  }
  if (state.storage) {
    if (!(await state.storage.recordBlackboardAdmissionBlock(session.id, !allowed))) return false;
  }
  if (allowed) delete session.reportingAdmissionBlocked;
  else session.reportingAdmissionBlocked = true;
  return allowed;
}

import * as audit from "./control-plane-audit.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import type {
  AuditLogInput,
  AuditLogListQuery,
  AuditLogPage,
  AuditLogRecord,
} from "./audit-types.ts";

/** Immutable audit history is a facade concern, not a domain mutation helper. */
export class ControlPlaneAuditService {
  constructor(readonly state: ControlPlaneState) {}

  /** Callers must not acknowledge their mutation if this append rejects. */
  appendAuditLog(input: AuditLogInput): Promise<AuditLogRecord> {
    return audit.appendAuditLog(this.state, input);
  }

  listAuditLogs(query?: AuditLogListQuery): Promise<AuditLogPage> {
    return audit.listAuditLogs(this.state, query);
  }
}

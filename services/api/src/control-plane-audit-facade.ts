import * as audit from "./control-plane-audit.ts";
import { ControlPlaneBase } from "./control-plane-facade.ts";
import type {
  AuditLogInput,
  AuditLogListQuery,
  AuditLogPage,
  AuditLogRecord,
} from "./audit-types.ts";

/** Immutable audit history is a facade concern, not a domain mutation helper. */
export class ControlPlaneAuditFacade extends ControlPlaneBase {
  /** Callers must not acknowledge their mutation if this append rejects. */
  appendAuditLog(input: AuditLogInput): Promise<AuditLogRecord> {
    return audit.appendAuditLog(this.state, input);
  }

  listAuditLogs(query?: AuditLogListQuery): Promise<AuditLogPage> {
    return audit.listAuditLogs(this.state, query);
  }
}

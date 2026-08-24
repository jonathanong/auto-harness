/* eslint-disable typescript/no-unsafe-declaration-merging --
 * Service methods are copied onto the class prototype at module load so
 * `plane.createSession()` stays a compatibility wrapper without inheritance.
 */
import type { HostWireMessage } from "@auto-harness/shared";

import {
  createControlPlaneState,
  hydrateFromStorage,
  settleStorage,
  type ControlPlaneState,
} from "./control-plane-state.ts";
import type { ControlPlaneOptions } from "./control-plane-types.ts";
import { ControlPlaneAuditService } from "./control-plane-audit-facade.ts";
import { ControlPlaneCatalogService } from "./control-plane-catalog-ext.ts";
import { ControlPlaneHostsService } from "./control-plane-hosts-service.ts";
import { ControlPlaneIntegrationsService } from "./control-plane-integrations-service.ts";
import { ControlPlaneRepositoriesService } from "./control-plane-repositories-service.ts";
import { ControlPlaneSchedulingService } from "./control-plane-scheduling-service.ts";
import { ControlPlaneSessionsService } from "./control-plane-sessions-service.ts";
import { bindControlPlaneServices } from "./control-plane-service-bind.ts";

export type {
  ArchiveMetadata,
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PublicSession,
  ScheduleRecord,
} from "./control-plane-types.ts";

/**
 * Control plane for Phases 2–5 (invariants 1–9).
 * Prefer {@link createControlPlane} so state is backed by DynamoDB Local / AWS.
 * Working-set Maps are a process cache; durable truth is DynamoDB when `storage` is set.
 *
 * Domain logic lives on composed services. Methods on this class remain a
 * compatibility wrapper so existing `plane.createSession()` callers keep working.
 */
export class ControlPlane {
  readonly state: ControlPlaneState;
  readonly sessions: ControlPlaneSessionsService;
  readonly scheduling: ControlPlaneSchedulingService;
  readonly hosts: ControlPlaneHostsService;
  readonly catalog: ControlPlaneCatalogService;
  readonly audit: ControlPlaneAuditService;
  readonly repositories: ControlPlaneRepositoriesService;
  readonly integrations: ControlPlaneIntegrationsService;

  constructor(options: ControlPlaneOptions = {}) {
    this.state = createControlPlaneState(options);
    this.sessions = new ControlPlaneSessionsService(this.state);
    this.scheduling = new ControlPlaneSchedulingService(this.state);
    this.hosts = new ControlPlaneHostsService(this.state);
    this.catalog = new ControlPlaneCatalogService(this.state);
    this.audit = new ControlPlaneAuditService(this.state);
    this.repositories = new ControlPlaneRepositoriesService(this.state);
    this.integrations = new ControlPlaneIntegrationsService(this.state);
  }

  setOnHostMessage(handler: ((hostId: string, msg: HostWireMessage) => void) | undefined): void {
    this.state.onHostMessage = handler;
  }

  async hydrateFromStorage(): Promise<void> {
    await hydrateFromStorage(this.state);
  }

  async settleStorage(): Promise<void> {
    await settleStorage(this.state);
  }
}

export interface ControlPlane
  extends
    ControlPlaneSessionsService,
    ControlPlaneSchedulingService,
    ControlPlaneHostsService,
    ControlPlaneCatalogService,
    ControlPlaneAuditService,
    ControlPlaneRepositoriesService,
    ControlPlaneIntegrationsService {}

bindControlPlaneServices(ControlPlane, [
  ControlPlaneSessionsService,
  ControlPlaneSchedulingService,
  ControlPlaneHostsService,
  ControlPlaneCatalogService,
  ControlPlaneAuditService,
  ControlPlaneRepositoriesService,
  ControlPlaneIntegrationsService,
]);

export { ControlPlane as ControlPlaneBase };

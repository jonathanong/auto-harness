import { awsArgs } from "./aws-cli.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

/**
 * Mirrors `services/api/src/db/plane-storage-session-drains.ts`'s
 * `sessionDrainLedgerReadyRecord()` and `services/api/src/db/ensure-session-priority-order.ts`'s
 * `SESSION_PRIORITY_ORDER_SCOPE_KEY` / `SESSION_PRIORITY_ORDER_READY_RECORD_KEY` (plus its inline
 * `"session-priority-order-v2"` record type), and `scripts/deploy-aws.sh`'s own
 * `write_readiness_marker` calls. All four must agree on these three literal values per marker.
 *
 * They are duplicated here on purpose, the same way `HEALTHY_LOGIN_HTML` duplicates a
 * services/web string into this package's test helpers: `.dependency-cruiser.cjs`'s
 * `no-cross-service` rule forbids one deployable service from importing another, so this
 * package cannot import the API service's constants. A rename on either side must update all
 * four call sites, or a future `deploy:aws` run stops recognizing a marker this deploy wrote.
 */
type ReadinessMarker = {
  readonly scopeKey: string;
  readonly recordKey: string;
  readonly recordType: string;
};

const SESSION_DRAIN_LEDGER_READY_MARKER: ReadinessMarker = {
  scopeKey: "__session-drain-ledger__",
  recordKey: "ACTIVITY-V1",
  recordType: "activity-ledger-v1",
};

const SESSION_PRIORITY_ORDER_READY_MARKER: ReadinessMarker = {
  scopeKey: "__session-priority-order__",
  recordKey: "READY-V2",
  recordType: "session-priority-order-v2",
};

/** Matches the `${config.tablePrefix}-<TableName>` convention in deployment-purge-schema.ts. */
function sessionDrainsTableName(config: DeploymentConfig): string {
  return `${config.tablePrefix}-SessionDrains`;
}

/**
 * Writes one marker only if absent, exactly like `write_readiness_marker()` in
 * scripts/deploy-aws.sh: a conditional-check failure means another writer (or a previous,
 * interrupted run of this same function) already published it, which is success, not an
 * error. This can never overwrite or clear an existing marker, including one with different
 * content — `attribute_not_exists` refuses the write outright when the item is already there.
 */
async function putReadinessMarkerIfAbsent(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  marker: ReadinessMarker,
): Promise<void> {
  const result = await dependencies.query(
    "aws",
    awsArgs(config, [
      "dynamodb",
      "put-item",
      "--table-name",
      sessionDrainsTableName(config),
      "--item",
      JSON.stringify({
        scopeKey: { S: marker.scopeKey },
        recordKey: { S: marker.recordKey },
        recordType: { S: marker.recordType },
      }),
      "--condition-expression",
      "attribute_not_exists(scopeKey)",
    ]),
  );
  if (result.status === 0) return;
  if (/ConditionalCheckFailedException/u.test(`${result.stderr}\n${result.stdout}`)) return;
  throw new Error(
    `could not publish readiness marker ${marker.recordKey}: ${result.stderr || result.stdout}`,
  );
}

/**
 * Publishes both readiness markers a brand-new environment needs so the very first
 * `pnpm deploy:aws` afterward takes its fast path instead of demanding a maintenance-fenced
 * migration rollout meant for an *existing* deployment mid-schema-change. A freshly created
 * environment has no legacy rows to migrate — it is already at the current schema by
 * construction — so there is nothing for that fence to protect here.
 *
 * Called only from `deploy()`, and only after `smokeDeployment` has confirmed the new stacks
 * are actually healthy: publishing readiness for a deploy that has not been verified would be
 * worse than the bug this fixes. `update()` must never call this — on an existing environment
 * these same markers mean "this migration has already been applied", and writing them there
 * would let a genuinely needed maintenance fence be skipped. That distinction is structural:
 * this function is wired into the `deploy` branch of `services/cdk/src/deployment.ts` only.
 */
export async function writeFreshDeployReadinessMarkers(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  await putReadinessMarkerIfAbsent(config, dependencies, SESSION_DRAIN_LEDGER_READY_MARKER);
  await putReadinessMarkerIfAbsent(config, dependencies, SESSION_PRIORITY_ORDER_READY_MARKER);
  dependencies.log(
    "Published session-drain-ledger and session-priority-order readiness markers for the new environment.",
  );
}

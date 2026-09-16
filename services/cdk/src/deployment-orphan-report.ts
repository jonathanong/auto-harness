import { awsArgs } from "./aws-cli.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import type { DeploymentDependencies } from "./deployment-support.ts";

/**
 * Warns when an ordinary `update` has just abandoned a live DynamoDB table.
 *
 * `purge` deletes these (deployment-purge-orphans.ts), but purge is not the only way to
 * create one, and until now it was the only path that looked. Dropping a table from
 * `services/cdk/src/tables.ts` and running `pnpm deploy:aws` against any environment
 * deployed with `HARNESS_DEPLOY_REMOVAL_POLICY=retain` — the default, and what production
 * uses — makes CloudFormation remove the resource from the stack while `DeletionPolicy:
 * Retain` keeps the table itself alive. It emits `DELETE_SKIPPED` and moves on. Nothing
 * fails, the deploy reports success, and a table full of data is left running and billing
 * with nothing managing it. That is exactly how AutoHarness-production-SessionLogs survived
 * on 2026-09-16, and once a stack no longer lists a resource, no later run can identify it:
 * findOrphanedTableNames reads the stack's own stored template, so an already-abandoned
 * table is invisible to every future purge. Catching it in the run that creates it is the
 * only moment the information still exists.
 *
 * Reports rather than deletes, deliberately. `update` is a routine deploy that operators
 * run constantly and that CI can run unattended; silently destroying a table with data as a
 * side effect of one would be far worse than leaving it. `purge` deletes because its whole
 * contract is destroying the environment and the operator typed
 * `destroy-all-data-in-<environment>` to get there. So this path names the table, says what
 * happened, and leaves the decision to a human.
 *
 * Does not throw for the same reason: the stack update itself succeeded and the environment
 * is healthy. Failing the deploy here would turn a warning about a leftover resource into a
 * red deploy, which teaches people to ignore it.
 */
export async function reportOrphanedTablesAfterUpdate(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  candidateTableNames: readonly string[],
): Promise<string[]> {
  const survivors: string[] = [];
  for (const tableName of candidateTableNames) {
    const result = await dependencies.query(
      "aws",
      awsArgs(config, ["dynamodb", "describe-table", "--table-name", tableName]),
    );
    // Absent is the good outcome: the stored template carried DeletionPolicy: Delete, so
    // this update removed the table properly and there is nothing to report.
    if (result.status !== 0) continue;
    survivors.push(tableName);
  }
  if (survivors.length === 0) return survivors;

  dependencies.log(
    `WARNING: this update removed ${String(survivors.length)} DynamoDB table(s) from ` +
      `${config.foundationStackName} but left them running, because their DeletionPolicy is ` +
      "Retain: " +
      survivors.join(", ") +
      ". They are no longer managed by any stack, still hold their data, and will not be " +
      "found by a future purge — purge identifies orphans from the stack's stored template, " +
      "which no longer mentions them. Delete each one by hand when you are sure it is not " +
      "needed:",
  );
  for (const tableName of survivors) {
    dependencies.log(
      `  aws dynamodb update-table --table-name ${tableName} --no-deletion-protection-enabled && ` +
        `aws dynamodb wait table-exists --table-name ${tableName} && ` +
        `aws dynamodb delete-table --table-name ${tableName}`,
    );
  }
  return survivors;
}

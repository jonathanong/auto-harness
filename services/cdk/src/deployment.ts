import type { DeploymentConfig, DeploymentOperation } from "./deployment-config.ts";
import {
  deleteSecretParameters,
  emptyArchiveBucket,
  retargetFoundationForDeletion,
} from "./deployment-purge.ts";
import {
  applyDeployment,
  bootstrapEnvironment,
  type DeploymentDependencies,
  destroyStacks,
  smokeDeployment,
  stackOutput,
  stackState,
  verifySecretParameters,
} from "./deployment-support.ts";

async function requireCompleteDeployment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  operation: "deployment" | "update",
): Promise<void> {
  const state = await stackState(config, dependencies);
  if (!state.foundation || !state.runtime || !state.web) {
    throw new Error(`${operation} completed without all application stacks`);
  }
}

async function deploy(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  const state = await stackState(config, dependencies);
  if (state.foundation || state.runtime || state.web) {
    throw new Error(
      "deploy requires all application stacks to be absent; use update for an existing environment",
    );
  }
  await verifySecretParameters(config, dependencies);
  await bootstrapEnvironment(config, dependencies);
  await applyDeployment(config, dependencies);
  await requireCompleteDeployment(config, dependencies, "deployment");
  await smokeDeployment(config, dependencies);
}

async function update(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  const state = await stackState(config, dependencies);
  if (!state.foundation) {
    throw new Error(
      "update requires the foundation stack to exist; use deploy for a new environment",
    );
  }
  await verifySecretParameters(config, dependencies);
  await applyDeployment(config, dependencies);
  await requireCompleteDeployment(config, dependencies, "update");
  await smokeDeployment(config, dependencies);
}

async function teardown(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  if (config.teardownConfirmation !== config.environment) {
    throw new Error(
      `teardown requires HARNESS_DEPLOY_CONFIRM=${config.environment}; data follows the deployed stack's retention policy`,
    );
  }
  const { foundation, runtime, web } = await stackState(config, dependencies);
  if (!foundation && !runtime && !web) throw new Error("teardown found no application stacks");
  const stackNames = [
    ...(web ? [config.webStackName] : []),
    ...(runtime ? [config.runtimeStackName] : []),
    ...(foundation && config.removalPolicy === "destroy" ? [config.foundationStackName] : []),
  ];
  if (stackNames.length > 0) await destroyStacks(config, dependencies, stackNames);
  const tornDown = await stackState(config, dependencies);
  const expectedFoundation = foundation && config.removalPolicy === "retain";
  if (tornDown.web || tornDown.runtime || tornDown.foundation !== expectedFoundation) {
    throw new Error("teardown completed with an unexpected application stack state");
  }
  dependencies.log(
    expectedFoundation
      ? `Runtime teardown complete for ${config.environment}; retained foundation and data.`
      : `Teardown complete for environment ${config.environment}.`,
  );
}

function expectedPurgeConfirmation(config: DeploymentConfig): string {
  return `destroy-all-data-in-${config.environment}`;
}

/**
 * Irreversibly removes everything teardown leaves behind. Two separate explicit
 * confirmations are required — teardown's own HARNESS_DEPLOY_CONFIRM plus a purge-specific
 * value naming the environment again — so a single already-set variable (e.g. left over from
 * a prior teardown) can't silently authorize this too; both are still deterministic from the
 * environment name, not a secret or an access-control check. Order matters: web and runtime
 * (the archive bucket's only writers — the cron Lambda archives session logs on a 1-minute
 * schedule) are destroyed *before* the bucket's deletion policy is retargeted or its contents
 * are removed, so nothing can write back into a bucket mid-empty.
 */
async function purge(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  if (config.teardownConfirmation !== config.environment) {
    throw new Error(`purge requires HARNESS_DEPLOY_CONFIRM=${config.environment}`);
  }
  const expectedPurge = expectedPurgeConfirmation(config);
  if (config.purgeConfirmation !== expectedPurge) {
    throw new Error(`purge requires HARNESS_DEPLOY_PURGE_CONFIRM=${expectedPurge}`);
  }
  const state = await stackState(config, dependencies);
  if (!state.foundation && !state.runtime && !state.web) {
    throw new Error("purge found no application stacks");
  }

  const runtimeAndWeb = [
    ...(state.web ? [config.webStackName] : []),
    ...(state.runtime ? [config.runtimeStackName] : []),
  ];
  if (runtimeAndWeb.length > 0) await destroyStacks(config, dependencies, runtimeAndWeb);

  if (state.foundation) {
    await retargetFoundationForDeletion(config, dependencies);
    const bucketName = await stackOutput(
      config,
      dependencies,
      config.foundationStackName,
      "ArchiveBucketName",
    );
    await emptyArchiveBucket(config, dependencies, bucketName);
    await destroyStacks(config, dependencies, [config.foundationStackName]);
  }

  if (config.purgeSsmParameters) await deleteSecretParameters(config, dependencies);

  const remaining = await stackState(config, dependencies);
  if (remaining.foundation || remaining.runtime || remaining.web) {
    throw new Error("purge completed with a surviving application stack");
  }
  const destroyed = [
    ...(state.web ? ["web"] : []),
    ...(state.runtime ? ["runtime"] : []),
    ...(state.foundation ? ["foundation"] : []),
  ];
  dependencies.log(
    `Purge complete for environment ${config.environment}: destroyed ${destroyed.join(", ")}. ` +
      "The integration KMS key is scheduled for deletion after its 7-day pending window, " +
      "not deleted immediately." +
      (config.purgeSsmParameters
        ? ""
        : " SSM parameters were left in place (opt in with HARNESS_DEPLOY_PURGE_SSM=1)."),
  );
}

export async function runDeployment(
  operation: DeploymentOperation,
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  if (operation === "deploy") return deploy(config, dependencies);
  if (operation === "update") return update(config, dependencies);
  if (operation === "purge") return purge(config, dependencies);
  return teardown(config, dependencies);
}

import type { DeploymentConfig, DeploymentOperation } from "./deployment-config.ts";
import {
  applyDeployment,
  bootstrapEnvironment,
  type DeploymentDependencies,
  destroyStacks,
  smokeDeployment,
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

export async function runDeployment(
  operation: DeploymentOperation,
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  if (operation === "deploy") return deploy(config, dependencies);
  if (operation === "update") return update(config, dependencies);
  return teardown(config, dependencies);
}

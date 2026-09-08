import { spawn } from "node:child_process";

import { awsCliEnv } from "../services/cdk/src/aws-cli.ts";
import {
  deploymentConfig,
  type DeploymentOperation,
} from "../services/cdk/src/deployment-config.ts";
import { runDeployment } from "../services/cdk/src/deployment.ts";
import { applySessionPriorityIndexStage } from "../services/cdk/src/deployment-support.ts";
import type {
  DeploymentDependencies,
  DeploymentQueryResult,
} from "../services/cdk/src/deployment-support.ts";

function operation(
  value: string | undefined,
): DeploymentOperation | "priority-index-status" | "priority-index-both" {
  if (value === "deploy" || value === "update" || value === "teardown" || value === "purge") {
    return value;
  }
  if (value === "priority-index-status" || value === "priority-index-both") return value;
  throw new Error(
    "usage: aws-deployment.mts <deploy|update|teardown|purge|priority-index-status|priority-index-both>",
  );
}

const query = (command: string, args: string[]): Promise<DeploymentQueryResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: awsCliEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: awsCliEnv(), shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${String(status)}`));
    });
  });

const dependencies: DeploymentDependencies = { fetch, log: console.log, query, run };

try {
  const selected = operation(process.argv[2]);
  if (selected === "priority-index-status" || selected === "priority-index-both") {
    const config = deploymentConfig("update");
    await applySessionPriorityIndexStage(
      config,
      dependencies,
      selected === "priority-index-status" ? "status" : "both",
    );
  } else {
    await runDeployment(selected, deploymentConfig(selected), dependencies);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

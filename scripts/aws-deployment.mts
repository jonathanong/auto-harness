import { spawn } from "node:child_process";

import {
  deploymentConfig,
  type DeploymentOperation,
} from "../services/cdk/src/deployment-config.ts";
import { runDeployment } from "../services/cdk/src/deployment.ts";
import type {
  DeploymentDependencies,
  DeploymentQueryResult,
} from "../services/cdk/src/deployment-support.ts";

function operation(value: string | undefined): DeploymentOperation {
  if (value === "deploy" || value === "update" || value === "teardown") return value;
  throw new Error("usage: aws-deployment.mts <deploy|update|teardown>");
}

const query = (command: string, args: string[]): Promise<DeploymentQueryResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${String(status)}`));
    });
  });

const dependencies: DeploymentDependencies = { fetch, log: console.log, query, run };

try {
  const selected = operation(process.argv[2]);
  await runDeployment(selected, deploymentConfig(selected), dependencies);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

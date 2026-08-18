import type { DeploymentConfig } from "./deployment-config.ts";

export type DeploymentQueryResult = { status: number | null; stderr: string; stdout: string };

export type DeploymentDependencies = {
  fetch: typeof fetch;
  log: (message: string) => void;
  query: (command: string, args: string[]) => Promise<DeploymentQueryResult>;
  run: (command: string, args: string[]) => Promise<void>;
};

function awsArgs(config: DeploymentConfig, args: string[]): string[] {
  return [...args, "--region", config.region];
}

async function queryOk(
  dependencies: DeploymentDependencies,
  command: string,
  args: string[],
): Promise<string> {
  const result = await dependencies.query(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function stackExists(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  stackName: string,
): Promise<boolean> {
  const result = await dependencies.query(
    "aws",
    awsArgs(config, ["cloudformation", "describe-stacks", "--stack-name", stackName]),
  );
  if (result.status === 0) return true;
  if (/does not exist/u.test(`${result.stderr}\n${result.stdout}`)) return false;
  throw new Error(`unable to inspect stack ${stackName}: ${result.stderr || result.stdout}`);
}

function cdkContext(config: DeploymentConfig): string[] {
  return [
    "--app",
    "node src/cli.ts",
    "-c",
    `stackName=${config.foundationStackName}`,
    "-c",
    `runtimeStackName=${config.runtimeStackName}`,
    "-c",
    `webStackName=${config.webStackName}`,
    "-c",
    `tablePrefix=${config.tablePrefix}`,
    "-c",
    `removalPolicy=${config.removalPolicy}`,
  ];
}

export async function verifySecretParameters(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  for (const name of [
    config.adminsSsmParam,
    config.sessionSecretSsmParam,
    config.cursorSecretSsmParam,
  ]) {
    await queryOk(
      dependencies,
      "aws",
      awsArgs(config, [
        "ssm",
        "get-parameter",
        "--name",
        name,
        "--query",
        "Parameter.Name",
        "--output",
        "text",
      ]),
    );
  }
}

export async function bootstrapEnvironment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  const account =
    config.accountId ??
    (await queryOk(
      dependencies,
      "aws",
      awsArgs(config, ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]),
    ));
  dependencies.log(`Bootstrapping CDK in ${account}/${config.region}...`);
  await dependencies.run("pnpm", ["exec", "cdk", "bootstrap", `aws://${account}/${config.region}`]);
}

export async function applyDeployment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  await dependencies.run("pnpm", [
    "exec",
    "cdk",
    "deploy",
    config.foundationStackName,
    config.runtimeStackName,
    config.webStackName,
    ...cdkContext(config),
    "--require-approval",
    "never",
    "--parameters",
    `${config.runtimeStackName}:HarnessAdminsSsmParam=${config.adminsSsmParam}`,
    "--parameters",
    `${config.runtimeStackName}:HarnessSessionSecretSsmParam=${config.sessionSecretSsmParam}`,
    "--parameters",
    `${config.runtimeStackName}:HarnessCursorSecretSsmParam=${config.cursorSecretSsmParam}`,
  ]);
}

async function stackOutput(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  stackName: string,
  outputKey: string,
): Promise<string> {
  const value = await queryOk(
    dependencies,
    "aws",
    awsArgs(config, [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      stackName,
      "--query",
      `Stacks[0].Outputs[?OutputKey=='${outputKey}'].OutputValue | [0]`,
      "--output",
      "text",
    ]),
  );
  if (!value || value === "None") throw new Error(`${stackName} has no ${outputKey}`);
  return value;
}

export async function smokeDeployment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  const restApiUrl = await stackOutput(config, dependencies, config.runtimeStackName, "RestApiUrl");
  const response = await dependencies.fetch(new URL("health", `${restApiUrl}/`));
  if (!response.ok) throw new Error(`REST health check failed with HTTP ${response.status}`);
  const body = (await response.json()) as { ok?: unknown };
  if (body.ok !== true) throw new Error("REST health check returned an unexpected body");
  dependencies.log(`REST health check passed: ${restApiUrl}`);
  const webUrl = await stackOutput(config, dependencies, config.webStackName, "WebUrl");
  const webResponse = await dependencies.fetch(new URL("login", `${webUrl}/`));
  if (!webResponse.ok) throw new Error(`web health check failed with HTTP ${webResponse.status}`);
  dependencies.log(`Web health check passed: ${webUrl}`);
  // The runtime stack's raw WebSocketUrl output (a different execute-api hostname) is
  // deliberately not read or printed here: it is not a value to hand to a host daemon.
  // CloudFront (WebUrl) fronts both the REST and WebSocket API Gateway APIs on one hostname,
  // which is the only endpoint a single HARNESS_API_URL can serve both from. See
  // docs/aws.md#websocket-wss.
  const agentEndpoint = new URL(webUrl);
  agentEndpoint.protocol = "wss:";
  agentEndpoint.pathname = "/ws";
  dependencies.log(`Agent WebSocket endpoint: ${agentEndpoint.toString()}`);
  dependencies.log(`Set on each host: HARNESS_API_URL=${webUrl}`);
}

export async function stackState(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<{ foundation: boolean; runtime: boolean; web: boolean }> {
  return {
    foundation: await stackExists(config, dependencies, config.foundationStackName),
    runtime: await stackExists(config, dependencies, config.runtimeStackName),
    web: await stackExists(config, dependencies, config.webStackName),
  };
}

export async function destroyStacks(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  stackNames: string[],
): Promise<void> {
  await dependencies.run("pnpm", [
    "exec",
    "cdk",
    "destroy",
    ...stackNames,
    ...cdkContext(config),
    "--force",
  ]);
}

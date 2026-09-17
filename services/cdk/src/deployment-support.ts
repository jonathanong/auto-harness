/* eslint-disable max-lines -- shared deployment sequencing keeps stack mutations consistent. */
import { awsArgs } from "./aws-cli.ts";
import { probeAuthenticatedDeployment } from "./deploy-authenticated-smoke.ts";
import type { DeploymentConfig } from "./deployment-config.ts";
import { recycleRuntimeLambdas } from "./recycle-runtime-lambdas.ts";

export type DeploymentQueryResult = { status: number | null; stderr: string; stdout: string };

export type DeploymentDependencies = {
  fetch: typeof fetch;
  log: (message: string) => void;
  query: (command: string, args: string[]) => Promise<DeploymentQueryResult>;
  run: (command: string, args: string[]) => Promise<void>;
};

export async function queryOk(
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

export function cdkContext(
  config: DeploymentConfig,
  sessionPriorityIndexStage: "status" | "both" = "both",
  sessionCreatedOrderIndexStage: "none" | "status" = "status",
): string[] {
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
    "-c",
    `accessLogsEnabled=${String(config.accessLogsEnabled)}`,
    "-c",
    `sessionPriorityIndexStage=${sessionPriorityIndexStage}`,
    "-c",
    `sessionCreatedOrderIndexStage=${sessionCreatedOrderIndexStage}`,
    ...(config.apiSentryDsn ? (["-c", `apiSentryDsn=${config.apiSentryDsn}`] as const) : []),
    ...(config.webSentryDsnClient
      ? (["-c", `webSentryDsnClient=${config.webSentryDsnClient}`] as const)
      : []),
    ...(config.webSentryDsnServer
      ? (["-c", `webSentryDsnServer=${config.webSentryDsnServer}`] as const)
      : []),
  ];
}

/**
 * Existing DynamoDB tables accept just one GSI create in a stack update. The
 * deploy wrapper calls this twice, waiting for the first index to be ACTIVE
 * before allowing the template to contain the second one.
 */
export async function applySessionPriorityIndexStage(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
  stage: "status" | "both",
): Promise<void> {
  await dependencies.run("pnpm", [
    "exec",
    "cdk",
    "deploy",
    config.foundationStackName,
    ...cdkContext(config, stage, "none"),
    "--require-approval",
    "never",
  ]);
}

/** Add the created-order GSI after the priority GSIs are already present. */
export async function applySessionCreatedOrderIndexStage(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  await dependencies.run("pnpm", [
    "exec",
    "cdk",
    "deploy",
    config.foundationStackName,
    ...cdkContext(config, "both", "status"),
    "--require-approval",
    "never",
  ]);
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
    "--parameters",
    `${config.runtimeStackName}:HarnessPublicBaseUrlSsmParam=${config.publicBaseUrlSsmParam}`,
    "--parameters",
    `${config.runtimeStackName}:HarnessSlackAppSsmParam=${config.slackAppSsmParam}`,
  ]);
}

export async function stackOutput(
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

/**
 * Markers the deployed login page must actually render. HTTP 200 on its own proved
 * nothing: the CloudFront-ingress-token and swallowed-control-flow bugs of 2026-09-16
 * both served 200 on every page while rendering no usable content, so this smoke check
 * passed a deployment whose entire UI was dead. `page-login` is the server component's
 * own shell; `form-login` additionally proves the client subtree really server-rendered.
 */
const LOGIN_CONTENT_MARKERS = ['data-pw="page-login"', 'data-pw="form-login"'];

/**
 * Next control-flow errors carry a digest like `NEXT_REDIRECT;replace;/login;307;`. It
 * belongs in the server log, never in delivered HTML — a page that renders one caught a
 * redirect it should have re-thrown (see services/web/src/lib/page-error.ts). A healthy
 * page emits no `NEXT_`-prefixed token at all; Next's own inline payload is `__next_f`.
 */
const CONTROL_FLOW_DIGEST = /NEXT_[A-Z_]+/u;

function assertLoginRendered(html: string): void {
  const missing = LOGIN_CONTENT_MARKERS.filter((marker) => !html.includes(marker));
  if (missing.length > 0) {
    throw new Error(
      `web health check returned HTTP 200 without rendering the login form (missing ${missing.join(", ")})`,
    );
  }
  const digest = CONTROL_FLOW_DIGEST.exec(html);
  if (digest) {
    throw new Error(`web health check leaked a Next control-flow digest: ${digest[0]}`);
  }
}

export async function smokeDeployment(
  config: DeploymentConfig,
  dependencies: DeploymentDependencies,
): Promise<void> {
  // The runtime API Gateway URL deliberately accepts only the CloudFront origin credential.
  // Probe through the public distribution, as every browser and host daemon does, rather
  // than teaching this lifecycle script a private ingress credential.
  const webUrl = await stackOutput(config, dependencies, config.webStackName, "WebUrl");
  const response = await dependencies.fetch(new URL("health", `${webUrl}/`));
  if (!response.ok)
    throw new Error(`CloudFront API health check failed with HTTP ${response.status}`);
  const body = (await response.json()) as { ok?: unknown };
  if (body.ok !== true) throw new Error("CloudFront API health check returned an unexpected body");
  dependencies.log(`CloudFront API health check passed: ${webUrl}`);
  // `redirect: "manual"` because the login page must be terminal. Following redirects
  // hides the bounce loop that made a deployed environment unusable on 2026-09-12: a
  // session check that always failed sent every page, login included, back to /login.
  const webResponse = await dependencies.fetch(new URL("login", `${webUrl}/`), {
    redirect: "manual",
  });
  if (!webResponse.ok) throw new Error(`web health check failed with HTTP ${webResponse.status}`);
  assertLoginRendered(await webResponse.text());
  dependencies.log(`Web health check passed: ${webUrl}`);
  // Authenticated surface, not just the two unauthenticated checks above: every bug that
  // took production down on 2026-09-16 returned a good status code on unauthenticated
  // surface. Runs in this same validate-before-propagate phase, alongside the health/login
  // checks above and before the config writes below (publish WebUrl, recycle Lambdas) --
  // not because those writes are unsafe on a broken deploy, but because a deploy this
  // check cannot yet vouch for should not be marked healthy by writing anything further.
  // See deploy-authenticated-smoke.ts.
  await probeAuthenticatedDeployment(config, dependencies, webUrl);
  // Runtime cannot know WebUrl at synth/deploy time — Web depends on Runtime, not the
  // reverse, so CloudFront's domain doesn't exist yet when Runtime's Lambdas are created.
  // Publish it here, now that Web is confirmed healthy, so a session's `url` field, the
  // Slack integration's deep link, and viewer WebSocket Origin checks point at the real
  // control plane instead of ControlPlane's http://localhost:7421 default. See
  // public-base-url-param.ts.
  await dependencies.run(
    "aws",
    awsArgs(config, [
      "ssm",
      "put-parameter",
      "--type",
      "String",
      "--overwrite",
      "--name",
      config.publicBaseUrlSsmParam,
      "--value",
      webUrl,
    ]),
  );
  dependencies.log(`Published public base URL to ${config.publicBaseUrlSsmParam}`);
  // Lambdas that already cold-started fetched SSM before this write and still have
  // ControlPlane's localhost fallback. Touching configuration recycles them so the
  // next session.url uses WebUrl. See fetchPublicBaseUrl in lambda-handlers.ts.
  await recycleRuntimeLambdas(config, dependencies);
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

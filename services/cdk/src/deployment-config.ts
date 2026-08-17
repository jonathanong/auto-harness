export type DeploymentOperation = "deploy" | "teardown" | "update";

export type DeploymentConfig = {
  accountId?: string;
  adminsSsmParam: string;
  cursorSecretSsmParam: string;
  environment: string;
  foundationStackName: string;
  region: string;
  removalPolicy: "destroy" | "retain";
  runtimeStackName: string;
  sessionSecretSsmParam: string;
  tablePrefix: string;
  teardownConfirmation?: string;
  webOrigin?: string;
};

const environmentPattern = /^[a-z][a-z0-9-]{0,31}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWebOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("HARNESS_DEPLOY_WEB_ORIGIN must be an absolute URL");
  }
  if (url.origin !== value || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("HARNESS_DEPLOY_WEB_ORIGIN must be an exact HTTP(S) origin");
  }
  return value;
}

export function deploymentConfig(
  operation: DeploymentOperation,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  const environment = required(env, "HARNESS_DEPLOY_ENVIRONMENT");
  if (!environmentPattern.test(environment)) {
    throw new Error(
      "HARNESS_DEPLOY_ENVIRONMENT must start with a lowercase letter and contain only lowercase letters, numbers, or dashes (max 32 characters)",
    );
  }
  const region = env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim();
  if (!region) throw new Error("AWS_REGION or AWS_DEFAULT_REGION is required");
  const removalPolicy = env.HARNESS_DEPLOY_REMOVAL_POLICY?.trim() || "retain";
  if (removalPolicy !== "retain" && removalPolicy !== "destroy") {
    throw new Error("HARNESS_DEPLOY_REMOVAL_POLICY must be retain or destroy");
  }
  const base = `/auto-harness/${environment}`;
  return {
    adminsSsmParam: env.HARNESS_ADMINS_SSM_PARAM?.trim() || `${base}/harness-admins`,
    cursorSecretSsmParam:
      env.HARNESS_CURSOR_SECRET_SSM_PARAM?.trim() || `${base}/harness-cursor-secret`,
    environment,
    foundationStackName: `AutoHarness-${environment}-Foundation`,
    region,
    removalPolicy,
    runtimeStackName: `AutoHarness-${environment}-Runtime`,
    sessionSecretSsmParam:
      env.HARNESS_SESSION_SECRET_SSM_PARAM?.trim() || `${base}/harness-session-secret`,
    tablePrefix: `AutoHarness-${environment}`,
    ...(env.AWS_ACCOUNT_ID?.trim() ? { accountId: env.AWS_ACCOUNT_ID.trim() } : {}),
    ...(env.HARNESS_DEPLOY_CONFIRM?.trim()
      ? { teardownConfirmation: env.HARNESS_DEPLOY_CONFIRM.trim() }
      : {}),
    ...(operation === "teardown"
      ? {}
      : { webOrigin: parseWebOrigin(required(env, "HARNESS_DEPLOY_WEB_ORIGIN")) }),
  };
}

import { inspectSentryDsn } from "@auto-harness/shared";

import { sentryEnabled } from "./sentry-release.ts";

export type DeploymentOperation = "deploy" | "purge" | "teardown" | "update";

export type DeploymentConfig = {
  accessLogsEnabled: boolean;
  accountId?: string;
  adminsSsmParam: string;
  /** Empty by default. The alarm topic is created either way — see runtime-alarms.ts. */
  alarmEmails: string[];
  apiSentryDsn?: string;
  cursorSecretSsmParam: string;
  environment: string;
  foundationStackName: string;
  publicBaseUrlSsmParam: string;
  purgeConfirmation?: string;
  purgeSsmParameters: boolean;
  region: string;
  removalPolicy: "destroy" | "retain";
  runtimeStackName: string;
  sessionSecretSsmParam: string;
  slackAppSsmParam: string;
  tablePrefix: string;
  teardownConfirmation?: string;
  webSentryDsnClient?: string;
  webSentryDsnServer?: string;
  webStackName: string;
};

const environmentPattern = /^[a-z][a-z0-9-]{0,31}$/;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalDsn(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inspected = inspectSentryDsn(env[name]);
  if (inspected.kind === "unset") return undefined;
  if (inspected.kind === "invalid") {
    throw new Error(`${name} must be a Sentry DSN (https://<key>@<host>/<project>)`);
  }
  return inspected.dsn;
}

/**
 * Fails the deploy on a malformed address rather than accepting it, matching optionalDsn.
 * A silently-dropped address is the failure mode this whole feature exists to fix: the
 * operator believes alarms reach them and finds out otherwise during an incident. SNS would
 * also reject it later, at a point where nothing is watching the output.
 */
function alarmEmails(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [];
  const addresses = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const invalid = addresses.filter((entry) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(entry));
  if (invalid.length > 0) {
    throw new Error(`${name} contains an invalid email address: ${invalid.join(", ")}`);
  }
  return [...new Set(addresses)];
}

export function deploymentConfig(
  _operation: DeploymentOperation,
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
  const apiSentryDsn = optionalDsn(env, "HARNESS_API_SENTRY_DSN");
  const webSentryDsnClient = optionalDsn(env, "HARNESS_WEB_SENTRY_DSN_CLIENT");
  const webSentryDsnServer = optionalDsn(env, "HARNESS_WEB_SENTRY_DSN_SERVER");
  if (sentryEnabled(env)) {
    if (!apiSentryDsn || !webSentryDsnClient || !webSentryDsnServer) {
      throw new Error(
        "HARNESS_SENTRY_ENABLED=1 requires HARNESS_API_SENTRY_DSN, HARNESS_WEB_SENTRY_DSN_CLIENT, and HARNESS_WEB_SENTRY_DSN_SERVER",
      );
    }
  }
  return {
    // Default-safe opt-in, matching HARNESS_DEPLOY_PURGE_SSM: only the literal "1" enables it.
    // Access logs need a one-time, account-wide API Gateway CloudWatch Logs role that this
    // deploy does not provision — see scripts/bootstrap-apigateway-account.sh.
    accessLogsEnabled: env.HARNESS_ACCESS_LOGS_ENABLED?.trim() === "1",
    adminsSsmParam: env.HARNESS_ADMINS_SSM_PARAM?.trim() || `${base}/harness-admins`,
    alarmEmails: alarmEmails(env, "HARNESS_DEPLOY_ALARM_EMAILS"),
    cursorSecretSsmParam:
      env.HARNESS_CURSOR_SECRET_SSM_PARAM?.trim() || `${base}/harness-cursor-secret`,
    environment,
    foundationStackName: `AutoHarness-${environment}-Foundation`,
    publicBaseUrlSsmParam:
      env.HARNESS_PUBLIC_BASE_URL_SSM_PARAM?.trim() || `${base}/public-base-url`,
    purgeSsmParameters: env.HARNESS_DEPLOY_PURGE_SSM?.trim() === "1",
    region,
    removalPolicy,
    runtimeStackName: `AutoHarness-${environment}-Runtime`,
    sessionSecretSsmParam:
      env.HARNESS_SESSION_SECRET_SSM_PARAM?.trim() || `${base}/harness-session-secret`,
    slackAppSsmParam: env.HARNESS_SLACK_APP_SSM_PARAM?.trim() || `${base}/slack-app`,
    tablePrefix: `AutoHarness-${environment}`,
    webStackName: `AutoHarness-${environment}-Web`,
    ...(env.AWS_ACCOUNT_ID?.trim() ? { accountId: env.AWS_ACCOUNT_ID.trim() } : {}),
    ...(env.HARNESS_DEPLOY_CONFIRM?.trim()
      ? { teardownConfirmation: env.HARNESS_DEPLOY_CONFIRM.trim() }
      : {}),
    ...(env.HARNESS_DEPLOY_PURGE_CONFIRM?.trim()
      ? { purgeConfirmation: env.HARNESS_DEPLOY_PURGE_CONFIRM.trim() }
      : {}),
    ...(apiSentryDsn ? { apiSentryDsn } : {}),
    ...(webSentryDsnClient ? { webSentryDsnClient } : {}),
    ...(webSentryDsnServer ? { webSentryDsnServer } : {}),
  };
}

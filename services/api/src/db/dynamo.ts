import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SCAN_TABLE_NAMES } from "@auto-harness/shared";

/** Default endpoint for amazon/dynamodb-local (docker compose host port). */
export const DEFAULT_DYNAMODB_ENDPOINT = "http://127.0.0.1:7423";

export const SESSION_LOGS_TTL_ATTRIBUTE = "ttl";

/** Seconds until DynamoDB TTL expiry on the optional legacy SessionLogs adapter. */
export const SESSION_LOGS_TTL_SECONDS = 7 * 24 * 60 * 60;

export function sessionLogsTtlEpochSeconds(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000) + SESSION_LOGS_TTL_SECONDS;
}

export type DynamoTableNames = {
  users: string;
  sessions: string;
  sessionDrains: string;
  worktrees: string;
  workspacePools: string;
  workspaceSlots: string;
  connections: string;
  sessionLogs?: string;
  schedules: string;
  repositories: string;
  hostLocks: string;
  concurrencyLocks: string;
  archives: string;
  hostInventories: string;
  providers: string;
  providerAccounts: string;
  commands: string;
  auditLogs: string;
  rateLimits: string;
  viewerTickets: string;
  sessionUsage: string;
  sessionUsageKinds: string;
  integrations: string;
  notificationDeliveries: string;
  webhookDeliveries: string;
  sessionCancelRedeliveries: string;
  slackOAuthStates: string;
  slackInboundEvents: string;
};

/**
 * Every real `DynamoTableNames` field except the one optional, legacy-adapter table
 * (`sessionLogs`, which callers already branch on separately). Used to type-restrict test-only
 * helpers that Scan a caller-supplied table (e.g. plane-storage-clear.ts's `clearByKey`) to an
 * actual table field, without asserting anything about IAM grants.
 */
export type DynamoTableField = Exclude<keyof DynamoTableNames, "sessionLogs">;

/**
 * `DynamoTableNames` fields whose table is granted `dynamodb:Scan` under the rest/websocket/cron
 * Lambda role — i.e. the bare table name in `SCAN_TABLE_NAMES` (modules/shared, re-exported by
 * services/cdk/src/foundation-data-access.ts, which attaches the actual IAM grant) obtained by
 * capitalizing the field's first letter. Passing any other field to a parameterized Scan helper
 * (e.g. `listCatalogTablePage`) is then a compile error — the PR #748 class of bug (an ungranted
 * Scan, invisible locally, 500s in production) mechanically impossible for these helpers,
 * matching the static coverage `scripts/check-dynamo-scans.mts` already gives literal
 * `ctx.tables.x` call sites. The capitalize-the-field-name convention this relies on is asserted
 * against the real field-to-table map too — see `validateFieldCapitalization` in
 * scripts/dynamo-scan-field-map.mts — so a field that breaks the convention fails
 * `pnpm check:dynamo-scans` instead of silently miscomputing this type.
 */
export type ScannableTableField = {
  [K in DynamoTableField]: Capitalize<K> extends (typeof SCAN_TABLE_NAMES)[number] ? K : never;
}[DynamoTableField];

export function tableNames(prefix = "AutoHarness"): DynamoTableNames {
  const p = prefix.replace(/[^a-zA-Z0-9_.-]/g, "") || "AutoHarness";
  return {
    users: `${p}-Users`,
    sessions: `${p}-Sessions`,
    sessionDrains: `${p}-SessionDrains`,
    worktrees: `${p}-Worktrees`,
    workspacePools: `${p}-WorkspacePools`,
    workspaceSlots: `${p}-WorkspaceSlots`,
    connections: `${p}-Connections`,
    schedules: `${p}-Schedules`,
    repositories: `${p}-Repositories`,
    hostLocks: `${p}-HostLocks`,
    concurrencyLocks: `${p}-ConcurrencyLocks`,
    archives: `${p}-Archives`,
    hostInventories: `${p}-HostInventories`,
    providers: `${p}-Providers`,
    providerAccounts: `${p}-ProviderAccounts`,
    commands: `${p}-Commands`,
    auditLogs: `${p}-AuditLogs`,
    rateLimits: `${p}-RateLimits`,
    viewerTickets: `${p}-ViewerTickets`,
    sessionUsage: `${p}-SessionUsage`,
    sessionUsageKinds: `${p}-SessionUsageKinds`,
    integrations: `${p}-Integrations`,
    notificationDeliveries: `${p}-NotificationDeliveries`,
    webhookDeliveries: `${p}-WebhookDeliveries`,
    sessionCancelRedeliveries: `${p}-SessionCancelRedeliveries`,
    slackOAuthStates: `${p}-SlackOAuthStates`,
    slackInboundEvents: `${p}-SlackInboundEvents`,
  };
}

export type CreateDynamoClientOptions = {
  /** DynamoDB endpoint. `null` selects the AWS regional endpoint. */
  endpoint?: string | null;
  region?: string;
};

type DynamoClients = {
  client: DynamoDBClient;
  doc: DynamoDBDocumentClient;
};

/**
 * Low-level + document clients for DynamoDB Local (or AWS).
 * Local defaults: endpoint :7423, dummy credentials (required by the SDK).
 */
export function createDynamoClients(options: CreateDynamoClientOptions = {}): DynamoClients {
  const endpoint =
    options.endpoint === null
      ? undefined
      : (options.endpoint ?? process.env.HARNESS_DDB_ENDPOINT ?? DEFAULT_DYNAMODB_ENDPOINT);
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new DynamoDBClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
          },
        }
      : {}),
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { client, doc };
}

export function statusShardAttr(status: string, shard: number): string {
  return `${status}#${shard}`;
}

import type { ScanManifestEntry } from "./dynamo-scan-manifest.ts";

/**
 * Manifest entries for Scan call sites in `services/api/src/db/plane-storage-clear.ts` — the
 * only file listed in `SCAN_GRANT_EXEMPT_FILES`. `clearAll` is a DynamoDB-Local test-cleanup
 * helper (see its own docstring) invoked only from `.test.ts` files and `test-helpers/`; it is
 * never reachable from `cli.ts` or any Lambda handler, so these Scans never run under the
 * constrained rest/websocket/cron role and are exempt from the IAM-grant check.
 */
export const TEST_ONLY_SCAN_MANIFEST: readonly ScanManifestEntry[] = [
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "ctx.tables.hostLocks",
    count: 1,
    tables: ["HostLocks"],
    runsUnderLambdaRole: false,
    why: "DynamoDB Local test-cleanup helper (clearAll) only, never invoked outside .test.ts/test-helpers; HostLocks is deliberately excluded from the production Scan grant as a lock table.",
  },
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "ctx.tables.rateLimits",
    count: 1,
    tables: ["RateLimits"],
    runsUnderLambdaRole: false,
    why: "DynamoDB Local test-cleanup helper (clearAll) only, never invoked outside tests.",
  },
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "ctx.tables.concurrencyLocks",
    count: 1,
    tables: ["ConcurrencyLocks"],
    runsUnderLambdaRole: false,
    why: "DynamoDB Local test-cleanup helper (clearAll) only, never invoked outside tests.",
  },
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "sessionLogs",
    count: 1,
    tables: ["SessionLogs"],
    runsUnderLambdaRole: false,
    why: "DynamoDB Local test-cleanup helper (clearAll), guarded by a ResourceNotFoundException catch for stores without the optional table; never invoked outside tests.",
  },
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "ctx.tables.sessionDrains",
    count: 1,
    tables: ["SessionDrains"],
    runsUnderLambdaRole: false,
    why: "DynamoDB Local test-cleanup helper (clearSessionDrains) only; SessionDrains has its own production grant via plane-storage-session-drains.ts, but this call site never runs under the Lambda role.",
  },
  {
    file: "services/api/src/db/plane-storage-clear.ts",
    tableExpr: "tableName",
    count: 2,
    tables: [
      "WorkspaceSlots",
      "WorkspacePools",
      "NotificationDeliveries",
      "SessionCancelRedeliveries",
      "SlackOAuthStates",
      "ViewerTickets",
      "SlackInboundEvents",
    ],
    runsUnderLambdaRole: false,
    why: "generic per-table Scan+delete test helpers (clearByKey, clearByKeys) used only by DynamoDB Local test cleanup for these tables; never invoked outside tests.",
  },
];

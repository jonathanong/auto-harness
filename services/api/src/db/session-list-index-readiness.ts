import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { DynamoTableNames } from "./dynamo.ts";

export const SESSION_LIST_INDEXES_SCOPE_KEY = "__session-list-indexes__";
export const SESSION_LIST_INDEXES_READY_RECORD_KEY = "READY-V1";
export const SESSION_LIST_INDEXES_READY_RECORD_TYPE = "session-list-indexes-v1";

const NOT_READY_RECHECK_MS = 30_000;

/**
 * Whether the unsharded session-list indexes are ACTIVE and backfilled. The backfill publishes
 * the marker last and nothing ever clears it, so a positive answer is cached for the life of
 * the instance; a negative one is re-probed at most every 30 seconds. A failed probe counts as
 * not ready: the legacy status/shard plan is always correct, only slower.
 */
export class SessionListIndexReadiness {
  private readonly doc: DynamoDBDocumentClient;
  private readonly sessionDrains: string;
  private readonly now: () => number;
  private isReady = false;
  private recheckAt = 0;

  constructor(
    doc: DynamoDBDocumentClient,
    tables: Pick<DynamoTableNames, "sessionDrains">,
    now: () => number = Date.now,
  ) {
    this.doc = doc;
    this.sessionDrains = tables.sessionDrains;
    this.now = now;
  }

  markReady(): void {
    this.isReady = true;
  }

  async ready(): Promise<boolean> {
    if (this.isReady) return true;
    const now = this.now();
    if (now < this.recheckAt) return false;
    this.recheckAt = now + NOT_READY_RECHECK_MS;
    try {
      const response = await this.doc.send(
        new GetCommand({
          TableName: this.sessionDrains,
          Key: {
            scopeKey: SESSION_LIST_INDEXES_SCOPE_KEY,
            recordKey: SESSION_LIST_INDEXES_READY_RECORD_KEY,
          },
          ConsistentRead: true,
        }),
      );
      this.isReady = response.Item?.recordType === SESSION_LIST_INDEXES_READY_RECORD_TYPE;
    } catch {
      this.isReady = false;
    }
    return this.isReady;
  }
}

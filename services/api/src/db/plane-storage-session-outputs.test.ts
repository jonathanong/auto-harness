/* eslint-disable max-lines -- real Dynamo output races share one isolated table fixture. */
import { createHash } from "node:crypto";
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrepareSessionOutputsRequest } from "@auto-harness/shared";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";
import { DynamoSessionOutputsStore } from "./plane-storage-session-outputs.ts";
import { claimSessionRetention } from "./plane-storage-session-retention-claim.ts";
import { deleteSessionRetentionRelatedPage } from "./plane-storage-session-retention-related.ts";

const NOW = "2026-10-08T12:00:00.000Z";
const jsonText = "null";
const sha256 = createHash("sha256").update(jsonText).digest("hex");
const intent: PrepareSessionOutputsRequest = {
  attemptId: "attempt-1",
  capturedAt: NOW,
  output: { state: "ready", jsonText, sha256 },
  artifacts: {
    state: "pending",
    compressedBytes: 6,
    sourceBytes: 12,
    fileCount: 1,
    sha256: "a".repeat(64),
  },
};

let client: DynamoDBClient;
let tables: DynamoTableNames;
let store: DynamoSessionOutputsStore;
let doc: ReturnType<typeof createDynamoClients>["doc"];

function changeCreatedAt(id: string): Promise<void> {
  return doc
    .send(
      new UpdateCommand({
        TableName: tables.sessions,
        Key: { id },
        UpdateExpression: "SET createdAt = :created",
        ExpressionAttributeValues: { ":created": "2026-10-08T10:01:00.000Z" },
      }),
    )
    .then(() => undefined);
}

function storeWithChangeAfterManifestRead(change: () => Promise<void>) {
  let changed = false;
  return new (class extends DynamoSessionOutputsStore {
    override async getManifest(sessionId: string) {
      const manifest = await super.getManifest(sessionId);
      if (!changed) {
        changed = true;
        await change();
      }
      return manifest;
    }
  })({ doc, tables });
}

async function seed(id: string, fields: Record<string, unknown> = {}) {
  await doc.send(
    new PutCommand({
      TableName: tables.sessions,
      Item: {
        id,
        repositoryId: "repo",
        status: "completed",
        statusShard: "completed#0",
        createdAt: "2026-10-08T10:00:00.000Z",
        completedAt: "2026-10-08T11:00:00.000Z",
        attemptId: "attempt-1",
        hostId: "host-1",
        resolvedRoute: { hostId: "host-1", attemptId: "attempt-1" },
        sessionOutputsSupported: true,
        queueShard: 0,
        ...fields,
      },
    }),
  );
}

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  doc = clients.doc;
  tables = await ensureControlPlaneTables({ client, prefix: `AhOutput${process.pid}` });
  store = new DynamoSessionOutputsStore({ doc, tables });
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("session output durable intent and fences", () => {
  it("commits compact manifest, immutable JSON text, and upload lease together", async () => {
    await seed("sess-one");
    const manifest = await store.prepare("sess-one", intent, "host-1", NOW);
    expect(manifest).toMatchObject({
      outputState: "ready",
      artifactsState: "pending",
      sha256: "a".repeat(64),
    });
    expect(await store.getPayload("sess-one")).toMatchObject({ jsonText: "null", sha256 });
    const session = await store.getSession("sess-one");
    expect(Date.parse(session!.outputsUploadExpiresAt!)).toBeGreaterThan(Date.parse(NOW) + 360_000);
    expect(await store.prepare("sess-one", intent, "host-1", NOW)).toEqual(manifest);
    await expect(
      store.prepare(
        "sess-one",
        { ...intent, capturedAt: "2026-10-08T12:01:00.000Z" },
        "host-1",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_CONFLICT" });
    const raw = await doc.send(
      new GetCommand({
        TableName: tables.sessionOutputs,
        Key: { sessionId: "sess-one", recordKey: "manifest" },
      }),
    );
    expect(raw.Item).not.toHaveProperty("jsonText");
  });

  it("fences stale hosts, attempts, unsettled hooks and terminal retention", async () => {
    await seed("sess-fence");
    await expect(store.prepare("sess-fence", intent, "host-other", NOW)).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    await expect(
      store.prepare("sess-fence", { ...intent, attemptId: "other" }, "host-1", NOW),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessions,
        Key: { id: "sess-fence" },
        UpdateExpression: "SET terminalHookHandoff = :handoff",
        ExpressionAttributeValues: { ":handoff": { hostId: "host-1" } },
      }),
    );
    await expect(store.prepare("sess-fence", intent, "host-1", NOW)).rejects.toMatchObject({
      code: "OUTPUTS_NOT_SETTLED",
    });
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessions,
        Key: { id: "sess-fence" },
        UpdateExpression: "REMOVE terminalHookHandoff SET retentionToken = :token",
        ExpressionAttributeValues: { ":token": "claimed" },
      }),
    );
    await expect(store.prepare("sess-fence", intent, "host-1", NOW)).rejects.toMatchObject({
      code: "RETENTION_STARTED",
    });
  });

  it("rejects missing capability and submissions beyond the terminal retry window", async () => {
    await expect(store.prepare("unknown", intent, "host-1", NOW)).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    await seed("sess-unsupported", { sessionOutputsSupported: false });
    await expect(store.prepare("sess-unsupported", intent, "host-1", NOW)).rejects.toMatchObject({
      code: "STALE_ATTEMPT",
    });
    await seed("sess-expired", { completedAt: "2026-10-07T11:00:00.000Z" });
    await expect(store.prepare("sess-expired", intent, "host-1", NOW)).rejects.toMatchObject({
      code: "OUTPUTS_EXPIRED",
    });
    await seed("sess-unprepared");
    await expect(
      store.complete("sess-unprepared", "attempt-1", "host-1", NOW),
    ).rejects.toMatchObject({
      code: "OUTPUTS_NOT_PREPARED",
    });
  });

  it("is first-wins under simultaneous distinct manifests and refuses completion after attempt change", async () => {
    await seed("sess-race");
    const other = { ...intent, output: { state: "none" as const } };
    const results = await Promise.allSettled([
      store.prepare("sess-race", intent, "host-1", NOW),
      store.prepare("sess-race", other, "host-1", NOW),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = await store.getManifest("sess-race");
    expect(winner?.outputState).toMatch(/ready|none/);
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessions,
        Key: { id: "sess-race" },
        UpdateExpression: "SET attemptId = :attempt",
        ExpressionAttributeValues: { ":attempt": "attempt-2" },
      }),
    );
    await expect(
      store.complete("sess-race", "attempt-1", "host-1", NOW, { key: "fixed", versionId: "v1" }),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });
  });

  it("requires verified artifact pointer and makes completion idempotent", async () => {
    await seed("sess-complete");
    await store.prepare("sess-complete", intent, "host-1", NOW);
    await expect(store.complete("sess-complete", "attempt-1", "host-1", NOW)).rejects.toMatchObject(
      { code: "OUTPUTS_NOT_UPLOADED" },
    );
    const done = await store.complete("sess-complete", "attempt-1", "host-1", NOW, {
      key: "sessions/sess-complete/artifacts/fixed.tar.gz",
      versionId: "v1",
    });
    expect(done).toMatchObject({ artifactsState: "ready", objectVersionId: "v1" });
    expect(await store.complete("sess-complete", "attempt-1", "host-1", NOW)).toEqual(done);
  });

  it("blocks retention while an issued upload may still be in flight", async () => {
    await seed("sess-retain");
    await store.prepare("sess-retain", intent, "host-1", NOW);
    const session = (await store.getSession("sess-retain"))!;
    const ctx = { doc, tables };
    expect(await claimSessionRetention(ctx, session, NOW)).toBe(false);
    expect(
      await claimSessionRetention(ctx, session, new Date(Date.parse(NOW) + 371_000).toISOString()),
    ).toBe(true);
  });

  it("rechecks session and manifest generations in Dynamo transactions", async () => {
    await seed("sess-race-new");
    await expect(
      storeWithChangeAfterManifestRead(() => changeCreatedAt("sess-race-new")).prepare(
        "sess-race-new",
        intent,
        "host-1",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });

    await seed("sess-race-renew");
    await store.prepare("sess-race-renew", intent, "host-1", NOW);
    await expect(
      storeWithChangeAfterManifestRead(() => changeCreatedAt("sess-race-renew")).prepare(
        "sess-race-renew",
        intent,
        "host-1",
        NOW,
      ),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });

    await seed("sess-race-complete");
    await store.prepare("sess-race-complete", intent, "host-1", NOW);
    await expect(
      storeWithChangeAfterManifestRead(() => changeCreatedAt("sess-race-complete")).complete(
        "sess-race-complete",
        "attempt-1",
        "host-1",
        NOW,
        { key: "fixed", versionId: "v1" },
      ),
    ).rejects.toMatchObject({ code: "STALE_ATTEMPT" });

    await seed("sess-race-complete-winner");
    await store.prepare(
      "sess-race-complete-winner",
      { ...intent, artifacts: { state: "none" } },
      "host-1",
      NOW,
    );
    const winner = storeWithChangeAfterManifestRead(async () => {
      await doc.send(
        new UpdateCommand({
          TableName: tables.sessionOutputs,
          Key: { sessionId: "sess-race-complete-winner", recordKey: "manifest" },
          UpdateExpression: "SET completedAt = :now",
          ExpressionAttributeValues: { ":now": NOW },
        }),
      );
    });
    expect(
      await winner.complete("sess-race-complete-winner", "attempt-1", "host-1", NOW),
    ).toMatchObject({ completedAt: NOW });
  });

  it("surfaces Dynamo service failures instead of labeling them stale attempts", async () => {
    const unavailable = new (class extends DynamoSessionOutputsStore {
      override getSession(sessionId: string) {
        return store.getSession(sessionId);
      }
    })({ doc, tables: { ...tables, sessions: `${tables.sessions}-unavailable` } });
    await seed("sess-service-new");
    await expect(
      unavailable.prepare("sess-service-new", intent, "host-1", NOW),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
    await seed("sess-service-renew");
    await store.prepare("sess-service-renew", intent, "host-1", NOW);
    await expect(
      unavailable.prepare("sess-service-renew", intent, "host-1", NOW),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
    });
    await expect(
      unavailable.complete("sess-service-renew", "attempt-1", "host-1", NOW, {
        key: "fixed",
        versionId: "v1",
      }),
    ).rejects.toMatchObject({ name: "ResourceNotFoundException" });
  });

  it("shares the public Dynamo facade store and clears its persisted output rows", async () => {
    const storage = new DynamoPlaneStorage(doc, tables);
    const outputs = storage.getSessionOutputsStore();
    await seed("sess-facade");
    await outputs.prepare(
      "sess-facade",
      { ...intent, artifacts: { state: "none" } },
      "host-1",
      NOW,
    );
    expect(await storage.getSessionOutputsStore().getPayload("sess-facade")).toMatchObject({
      jsonText: "null",
    });
    await storage.clearAll();
    expect(await outputs.getManifest("sess-facade")).toBeNull();
    expect(await outputs.getPayload("sess-facade")).toBeNull();
  });

  it("deletes output manifest and payload rows through the bounded retention path", async () => {
    await seed("sess-retention-output-rows");
    await store.prepare(
      "sess-retention-output-rows",
      { ...intent, artifacts: { state: "none" } },
      "host-1",
      NOW,
    );
    expect(await store.getManifest("sess-retention-output-rows")).not.toBeNull();
    expect(await store.getPayload("sess-retention-output-rows")).not.toBeNull();
    const ctx = { doc, tables };
    expect(
      await deleteSessionRetentionRelatedPage(ctx, "sess-retention-output-rows", "outputs"),
    ).toBe(false);
    expect(await store.getManifest("sess-retention-output-rows")).toBeNull();
    expect(await store.getPayload("sess-retention-output-rows")).toBeNull();
    expect(
      await deleteSessionRetentionRelatedPage(ctx, "sess-retention-output-rows", "outputs"),
    ).toBe(true);
  });
});

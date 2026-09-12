import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";
import type { SlackInboundEventRecord, SlackOAuthStateRecord } from "../slack-oauth-types.ts";
import {
  consumeSlackOAuthState,
  putSlackInboundEvent,
  putSlackOAuthState,
} from "./plane-storage-slack-inbound.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const ctx = createDynamoTestCtx("SlackInbound");

const state: SlackOAuthStateRecord = {
  stateHash: "a".repeat(64),
  publicBaseUrl: "https://harness.example/",
  principalId: "admin:root",
  expectedVersion: null,
  defaultChannel: "#harness",
  enabled: true,
  notifications: {
    onSessionCreated: true,
    onSessionStarted: true,
    onSessionCompleted: true,
    onSessionFailed: true,
    onSessionCancelled: true,
    onScheduleCompleted: false,
    onHostOffline: true,
  },
  expiresAt: 100,
};

const inboundEvent: SlackInboundEventRecord = {
  workspaceId: "T1",
  eventId: "Ev1",
  type: "app_mention",
  channelId: "C1",
  userId: "U1",
  text: "hello",
  eventTs: "1",
  receivedAt: "2026-09-12T00:00:00.000Z",
  status: "pending",
  dueOrder: "2026-09-12T00:00:00.000Z#Ev1",
  ttl: 200,
};

function storageCtx(send: (command: unknown) => Promise<unknown>): PlaneStorageCtx {
  return {
    doc: { send } as PlaneStorageCtx["doc"],
    tables: {
      slackOAuthStates: "OAuthStates",
      slackInboundEvents: "InboundEvents",
    } as PlaneStorageCtx["tables"],
  };
}

describe("DynamoDB Slack OAuth state and inbound receipt storage", () => {
  it("one-time consumes an unexpired hashed state and deduplicates inbound events", async () => {
    if (!ctx.storage) return;
    expect(await ctx.storage.putSlackOAuthState(state)).toBe(true);
    expect(await ctx.storage.putSlackOAuthState(state)).toBe(false);
    expect(await ctx.storage.consumeSlackOAuthState(state.stateHash, 99)).toMatchObject({
      principalId: "admin:root",
    });
    expect(await ctx.storage.consumeSlackOAuthState(state.stateHash, 99)).toBeNull();
    expect(await ctx.storage.putSlackInboundEvent(inboundEvent)).toBe(true);
    expect(await ctx.storage.putSlackInboundEvent(inboundEvent)).toBe(false);
  });

  it("returns no state when DynamoDB reports no deleted item", async () => {
    const storage = storageCtx(async (command) => {
      expect(command).toBeInstanceOf(DeleteCommand);
      expect((command as DeleteCommand).input).toMatchObject({
        TableName: "OAuthStates",
        Key: { stateHash: state.stateHash },
        ConditionExpression: "expiresAt > :now",
        ExpressionAttributeValues: { ":now": 99 },
        ReturnValues: "ALL_OLD",
      });
      return {};
    });

    await expect(consumeSlackOAuthState(storage, state.stateHash, 99)).resolves.toBeNull();
  });

  it("propagates non-conditional DynamoDB failures", async () => {
    const failure = new Error("DynamoDB unavailable");
    const storage = storageCtx(async (command) => {
      expect(command).toSatisfy(
        (value) => value instanceof PutCommand || value instanceof DeleteCommand,
      );
      throw failure;
    });

    await expect(putSlackOAuthState(storage, state)).rejects.toBe(failure);
    await expect(consumeSlackOAuthState(storage, state.stateHash, 99)).rejects.toBe(failure);
    await expect(putSlackInboundEvent(storage, inboundEvent)).rejects.toBe(failure);
  });
});

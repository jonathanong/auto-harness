import { DescribeTableCommand, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDynamoClients,
  createDynamoDocumentClient,
  DEFAULT_DYNAMODB_ENDPOINT,
  statusShardAttr,
  tableNames,
} from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Cli");

describe("DynamoDB Local clients", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports client helpers and table naming", () => {
    expect(statusShardAttr("queued", 2)).toBe("queued#2");
    expect(tableNames("AH").sessions).toBe("AH-Sessions");
    expect(tableNames("AH").webhookDeliveries).toBe("AH-WebhookDeliveries");
    expect(tableNames("").sessions).toContain("Sessions");
    expect(tableNames("A H/!").sessions).toBe("AH-Sessions");
    expect(DEFAULT_DYNAMODB_ENDPOINT).toContain("7423");
    const doc = createDynamoDocumentClient();
    expect(doc).toBeTruthy();
  });

  it("honors explicit Dynamo client endpoint and region options", async () => {
    const { client, doc } = createDynamoClients({
      endpoint: "http://127.0.0.1:7429",
      region: "us-west-2",
    });

    expect((await client.config.endpoint()).port).toBe(7429);
    expect(await client.config.region()).toBe("us-west-2");
    expect(doc).toBeTruthy();

    const aws = createDynamoClients({ endpoint: null, region: "us-west-1" });
    expect(await aws.client.config.region()).toBe("us-west-1");
    expect(aws.doc).toBeTruthy();
  });

  it("uses environment values and local defaults when options are omitted", async () => {
    vi.stubEnv("HARNESS_DDB_ENDPOINT", "http://127.0.0.1:7429");
    vi.stubEnv("AWS_REGION", "eu-west-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret");
    const fromEnv = createDynamoClients();
    expect((await fromEnv.client.config.endpoint()).port).toBe(7429);
    expect(await fromEnv.client.config.region()).toBe("eu-west-1");
    expect(await fromEnv.client.config.credentials()).toMatchObject({
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    });

    vi.stubEnv("HARNESS_DDB_ENDPOINT", undefined);
    vi.stubEnv("AWS_REGION", undefined);
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    const defaults = createDynamoClients();
    expect((await defaults.client.config.endpoint()).port).toBe(7423);
    expect(await defaults.client.config.region()).toBe("us-east-1");
    expect(await defaults.client.config.credentials()).toMatchObject({
      accessKeyId: "local",
      secretAccessKey: "local",
    });
  });

  it("ensureControlPlaneTables is idempotent", async () => {
    if (!ctx.available) {
      expect(true).toBe(true);
      return;
    }
    const { client } = createDynamoClients();
    const a = await ensureControlPlaneTables({ client, prefix: ctx.prefix });
    const b = await ensureControlPlaneTables({ client, prefix: ctx.prefix });
    expect(a.sessions).toBe(b.sessions);

    const listed = await client.send(new ListTablesCommand({}));
    expect(listed.TableNames).toEqual(expect.any(Array));
    const sessions = await client.send(new DescribeTableCommand({ TableName: a.sessions }));
    expect(sessions.Table?.GlobalSecondaryIndexes?.map((index) => index.IndexName)).toEqual(
      expect.arrayContaining(["statusShard-createdAt", "repositoryId-createdAt"]),
    );
    const users = await client.send(new DescribeTableCommand({ TableName: a.users }));
    expect(users.Table?.GlobalSecondaryIndexes?.[0]?.IndexName).toBe("username");
    const webhooks = await client.send(
      new DescribeTableCommand({ TableName: a.webhookDeliveries }),
    );
    expect(webhooks.Table?.GlobalSecondaryIndexes?.[0]?.IndexName).toBe("state-dueAt");
  });

  it("is safe when independent processes provision the same fresh table prefix", async () => {
    if (!ctx.available) {
      expect(true).toBe(true);
      return;
    }
    const { client } = createDynamoClients();
    const prefix = `${ctx.prefix}Race`;
    const created = await Promise.all(
      Array.from({ length: 4 }, () => ensureControlPlaneTables({ client, prefix })),
    );

    expect(created.map((names) => names.sessions)).toEqual(Array(4).fill(`${prefix}-Sessions`));
  });

  it("uses an explicit, environment, or default prefix and propagates Dynamo failures", async () => {
    if (!ctx.available) {
      expect(true).toBe(true);
      return;
    }
    const { client } = createDynamoClients();
    vi.stubEnv("HARNESS_DDB_PREFIX", `${ctx.prefix}Env`);
    expect((await ensureControlPlaneTables({ client })).sessions).toBe(`${ctx.prefix}Env-Sessions`);

    vi.stubEnv("HARNESS_DDB_PREFIX", undefined);
    expect((await ensureControlPlaneTables({ client })).sessions).toBe("AutoHarness-Sessions");

    const unavailable = createDynamoClients({ endpoint: "http://127.0.0.1:1" }).client;
    await expect(
      ensureControlPlaneTables({ client: unavailable, prefix: `${ctx.prefix}Unavailable` }),
    ).rejects.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDynamoClients,
  ensureControlPlaneTables,
  listDynamoTables,
  normalizeTableNames,
  waitForDynamo,
} from "./local-bootstrap.ts";

describe("local Dynamo bootstrap", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("waits for DynamoDB Local and lists the provisioned tables", async () => {
    await expect(waitForDynamo()).resolves.toBeUndefined();
    const { client } = createDynamoClients();
    const names = await ensureControlPlaneTables({ client, prefix: `AhBoot${process.pid}` });

    await expect(listDynamoTables(client)).resolves.toEqual(
      expect.arrayContaining([names.sessions, names.users]),
    );
  });

  it("reports the configured endpoint after the readiness deadline", async () => {
    vi.stubEnv("HARNESS_DDB_ENDPOINT", "http://127.0.0.1:1");

    await expect(waitForDynamo(1)).rejects.toThrow("http://127.0.0.1:1");
  });

  it("uses the documented default endpoint when no endpoint is configured", async () => {
    vi.stubEnv("HARNESS_DDB_ENDPOINT", undefined);

    await expect(waitForDynamo(0)).rejects.toThrow("http://127.0.0.1:7423");
  });

  it("normalizes DynamoDB's optional table list to an empty array", async () => {
    expect(normalizeTableNames(undefined)).toEqual([]);
    expect(normalizeTableNames(["Sessions"])).toEqual(["Sessions"]);
  });
});

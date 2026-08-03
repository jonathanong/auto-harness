import { describe, expect, it } from "vitest";

import { describeControlPlane, DYNAMO_TABLES, getServiceName, statusShardKey } from "./index.ts";

describe("cdk tables", () => {
  it("includes sharded queue GSI and timestampSeq SessionLogs SK", () => {
    const sessions = DYNAMO_TABLES.find((t) => t.name === "Sessions");
    expect(sessions?.gsis?.some((g) => g.name === "statusShard-createdAt")).toBe(true);
    const logs = DYNAMO_TABLES.find((t) => t.name === "SessionLogs");
    expect(logs?.sortKey?.name).toBe("timestampSeq");
    expect(logs?.ttlAttribute).toBe("ttl");
    const connections = DYNAMO_TABLES.find((t) => t.name === "Connections");
    expect(connections?.gsis?.some((g) => g.name === "agentId")).toBe(true);
    expect(statusShardKey("queued", 2)).toBe("queued#2");
    const plane = describeControlPlane();
    expect(plane.tables.length).toBeGreaterThan(5);
    expect(plane.archiveBucket.name).toContain("archive");
    expect(plane.cron.rate).toContain("minute");
    expect(getServiceName()).toBe("@auto-harness/cdk");
  });
});

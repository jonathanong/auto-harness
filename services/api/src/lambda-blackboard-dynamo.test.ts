import { expect, it, beforeEach, afterEach, vi } from "vitest";
import { createDynamoTestCtx } from "../test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import {
  ARN,
  config,
  event,
  NOW,
  terminal,
} from "../test-helpers/blackboard-reporting-fixtures.ts";
import { ControlPlane } from "./control-plane.ts";
import { AuthService } from "./auth.ts";
import { createBlackboardReporting, reportingDelivery } from "./blackboard-reporting.ts";
import { createLambdaRuntime } from "./lambda-handlers.ts";

const ctx = createDynamoTestCtx("BbLambda");
beforeEach(async () => {
  await ctx.storage!.clearAll();
});
afterEach(() => vi.unstubAllEnvs());

it("routes the committed Sessions stream to verified delivery and reserves an exhausted invocation without claiming", async () => {
  const storage = ctx.storage!;
  const server = await blackboardServer();
  try {
    const plane = new ControlPlane({
      storage,
      shardCount: 1,
      now: () => NOW,
      blackboardReporting: createBlackboardReporting(config(server.url)),
    });
    vi.stubEnv("HARNESS_SESSION_STREAM_ARN", ARN);
    const auth = new AuthService({
      admins: Buffer.from(JSON.stringify([{ username: "operator", password: "fixture" }])).toString(
        "base64url",
      ),
      mode: "required",
      secret: "a".repeat(32),
    });
    const runtime = await createLambdaRuntime({
      auth,
      created: { plane, storage },
      management: { send: async () => ({}) },
    });
    const row = terminal();
    await storage.putSession(row);
    expect(
      await runtime.cron(event(row), { getRemainingTimeInMillis: () => 24_000 }),
    ).toMatchObject({ batchItemFailures: [] });
    const pending = (await storage.getWebhookDelivery(reportingDelivery(row)!.id))!;
    expect(pending).toMatchObject({ state: "pending", attemptCount: 0 });
    expect(server.entries.size).toBe(0);
    expect(await runtime.cron(event(row))).toMatchObject({ batchItemFailures: [] });
    expect(await storage.getWebhookDelivery(pending.id)).toMatchObject({
      state: "delivered",
      attemptCount: 1,
    });
    expect(server.entries.get(row.id)).toHaveLength(1);
    const retained = terminal({ id: "retained", attemptId: "other" });
    await storage.putSession(retained);
    // A low remaining budget still executes scheduler cleanup, without starting reporting work.
    expect(await runtime.cron({ getRemainingTimeInMillis: () => 9_000 })).toMatchObject({
      runningTimeoutsEnforced: 0,
    });
    expect(await storage.getWebhookDelivery(reportingDelivery(retained)!.id)).toBeNull();
    await runtime.cron();
    expect(await storage.getWebhookDelivery(reportingDelivery(retained)!.id)).toMatchObject({
      state: "delivered",
    });
  } finally {
    await server.close();
  }
});

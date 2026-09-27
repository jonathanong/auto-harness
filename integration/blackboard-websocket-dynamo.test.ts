import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  git,
  setupFeatureRepository,
  writeTerminalHook,
  startWebsocketServer,
} from "../test-helpers/blackboard-websocket-fixture.ts";
import { createControlPlane } from "../services/api/src/create-plane.ts";
import { createBlackboardReporting } from "../services/api/src/blackboard-reporting.ts";
import type { PublicSession } from "../services/api/src/control-plane-types.ts";
import { blackboardServer } from "../services/api/test-helpers/blackboard-server.ts";
import {
  createDynamoTestCtx,
  putActiveTestRepository,
} from "../services/api/test-helpers/dynamo-test-helpers.ts";
import { loadDaemonConfig } from "../services/host-daemon/src/config.ts";
import { startDaemon } from "../services/host-daemon/src/start-daemon.ts";
import { feedback } from "../test-helpers/blackboard-reporting-roundtrip.ts";
const ctx = createDynamoTestCtx(`Bws${randomUUID().slice(0, 6)}`);
async function request<T>(base: string, path: string, status: number, body?: unknown): Promise<T> {
  const response = await fetch(
    `${base}${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}
const create = (commandId: string) => ({
  repositoryId: "repo",
  prompt: "Inspect this feature",
  target: { commandId },
  timeout: 30,
  queueTtlSeconds: 300,
  ref: "feature/ws",
});

it("preserves feature checkout, hook context and failed outcome through production gates and verified terminal receipts", async () => {
  expect(ctx.storage).not.toBeNull();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "blackboard-websocket-")));
  const repositoryPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  const hook = join(root, "terminal.sh");
  const hookOutput = join(root, "hook.out");
  const blackboard = await blackboardServer();
  let server: Awaited<ReturnType<typeof startWebsocketServer>> | undefined;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const featureSha = await setupFeatureRepository(repositoryPath);
    writeTerminalHook(hook, hookOutput);
    await putActiveTestRepository(ctx.storage!, "repo");
    const reporting = createBlackboardReporting({
      schemaVersion: 1,
      version: 1,
      url: blackboard.url,
      token: "test-writer-credential",
      policies: [{ repositoryId: "repo", repository: "owner/repo", principalIds: ["system"] }],
    });
    const created = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      blackboardReporting: reporting,
    });
    const inventory = await created.plane.putHostInventoryDurable("host", {
      allowedRoots: [root],
      repositories: [
        {
          id: "repo",
          path: repositoryPath,
          defaultBranch: "main",
          terminalHookScript: hook,
          worktrees: [{ id: "worktree", name: "worktree", path: worktreePath, labels: [] }],
        },
      ],
      providerAccounts: [],
    });
    expect(inventory).toMatchObject({ ok: true });
    const commandScript = `if (process.env.AGENT_BLACKBOARD_TOKEN || process.env.AGENT_BLACKBOARD_URL) throw Error('controller credential leaked'); require('node:fs').writeFileSync(process.env.HARNESS_FEEDBACK_PATH, ${JSON.stringify(JSON.stringify(feedback))}); console.log('verified work');`;
    for (const [id, suffix] of [
      ["success", ""],
      ["failure", "process.exit(7)"],
    ]) {
      expect(
        created.plane.createCommand({
          id: id!,
          name: id!,
          argv: [basename(process.execPath), "-e", commandScript + suffix],
          appendPrompt: false,
          providerId: null,
        }),
      ).toMatchObject({ ok: true });
    }
    await created.plane.settleStorage();
    server = await startWebsocketServer(created.plane);
    const base = `http://127.0.0.1:${server.port}`;
    daemon = await startDaemon({
      config: await loadDaemonConfig({ env: { HARNESS_HOST_ID: "host", HARNESS_API_URL: base } }),
      childEnvSource: {
        ...process.env,
        HARNESS_DAEMON_LIVE_LOG_PORT: "off",
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      },
      inventoryPollMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    const complete = await request<PublicSession>(base, "/api/v1/sessions", 201, create("success"));
    await vi.waitFor(
      async () => {
        expect(
          await request<PublicSession>(base, `/api/v1/sessions/${complete.id}`, 200),
        ).toMatchObject({
          status: "completed",
          reporting: {
            deliveryStatus: "delivered",
            feedbackCoverage: "complete",
            completionStatus: "complete",
          },
        });
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(featureSha);
    expect(readFileSync(hookOutput, "utf8").trim().split("\n")).toEqual([
      complete.id,
      "completed",
      "feature/ws",
      worktreePath,
    ]);
    const rejected = await request<{ error: { code: string; message: string } }>(
      base,
      "/api/v1/sessions",
      400,
      create("not-a-command"),
    );
    expect(rejected.error).toEqual({
      code: "VALIDATION_ERROR",
      message: "commandId not-a-command not found",
    });
    writeTerminalHook(hook, hookOutput, 3);
    const failed = await request<PublicSession>(base, "/api/v1/sessions", 201, create("failure"));
    await vi.waitFor(
      async () => {
        expect(
          await request<PublicSession>(base, `/api/v1/sessions/${failed.id}`, 200),
        ).toMatchObject({
          status: "failed",
          exitCode: 7,
          reporting: { deliveryStatus: "delivered" },
        });
      },
      { timeout: 15_000, interval: 50 },
    );
    expect(readFileSync(hookOutput, "utf8").trim().split("\n")).toEqual([
      failed.id,
      "failed",
      "feature/ws",
      worktreePath,
    ]);
    for (const [id, outcome] of [
      [complete.id, "no-change"],
      [failed.id, "failure"],
    ]) {
      const entries = blackboard.entries.get(id!)!;
      const admissions = entries.filter((entry) => entry.data.workOutcome === "in-progress");
      const ids = admissions.map((entry) => entry.data.sourceEventId);
      expect(ids.some((sourceId) => sourceId.includes(":assignment-admission:"))).toBe(true);
      expect(ids.some((sourceId) => sourceId.includes(":command-admission:"))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
      expect(entries.filter((entry) => entry.data.type === "retrospective")).toHaveLength(1);
      expect(entries.at(-1)?.data.workOutcome).toBe(outcome);
      const result = await request<PublicSession>(base, `/api/v1/sessions/${id}`, 200);
      expect(result.reporting?.sourceEventId).toBe(entries.at(-1)?.data.sourceEventId);
      expect(result.reporting?.deliveredAt).toEqual(expect.any(String));
    }
  } finally {
    await daemon?.stop();
    await server?.close();
    await blackboard.close();
    rmSync(root, { recursive: true, force: true });
  }
});

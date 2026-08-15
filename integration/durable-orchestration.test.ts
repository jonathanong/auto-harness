import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createControlPlane } from "../services/api/src/create-plane.ts";
import type { LogRecord } from "../services/api/src/control-plane-types.ts";
import type { DynamoPlaneStorage } from "../services/api/src/db/plane-storage.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { loadDaemonConfig } from "../services/host-daemon/src/config.ts";
import { startDaemon } from "../services/host-daemon/src/start-daemon.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

const TABLE_PREFIX = "AutoHarnessIntegration";

type RunningServer = Awaited<ReturnType<typeof startLocalServer>>;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

async function jsonRequest<T>(
  base: string,
  path: string,
  expectedStatus: number,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  expect(response.status, `${init?.method ?? "GET"} ${path}: ${text}`).toBe(expectedStatus);
  return JSON.parse(text) as T;
}

async function waitForTerminal(base: string, sessionId: string): Promise<{ status: string }> {
  let session = { status: "queued" };
  for (let attempt = 0; attempt < 200; attempt++) {
    session = await jsonRequest<{ status: string }>(base, `/api/v1/sessions/${sessionId}`, 200);
    if (session.status === "completed" || session.status === "failed") return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return session;
}

let root: string | undefined;
let server: RunningServer | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
let storage: DynamoPlaneStorage | undefined;

afterEach(async () => {
  await stopDaemon?.();
  await server?.close();
  await storage?.clearAll();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  server = undefined;
  stopDaemon = undefined;
  storage = undefined;
});

describe("durable full-stack orchestration", () => {
  it("persists an HTTP-created session dispatched by the scheduler and run by a real daemon", async () => {
    root = mkdtempSync(join(tmpdir(), "ah-durable-orchestration-"));
    const repositoryPath = join(root, "repo");
    const worktreePath = join(root, "worktree");
    mkdirSync(repositoryPath);
    await git(repositoryPath, ["init"]);
    await git(repositoryPath, ["config", "user.email", "integration@auto-harness.local"]);
    await git(repositoryPath, ["config", "user.name", "Auto Harness Integration"]);
    writeFileSync(join(repositoryPath, "README.md"), "durable integration\n");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "initial"]);
    await git(repositoryPath, ["branch", "-M", "main"]);
    const mainSha = await git(repositoryPath, ["rev-parse", "main"]);

    const createdPlane = await createControlPlane({
      tablePrefix: TABLE_PREFIX,
      publicBaseUrl: "http://ui",
    });
    storage = createdPlane.storage;
    await storage.clearAll();

    const port = 21_000 + Math.floor(Math.random() * 1_000);
    server = await startLocalServer({
      port,
      plane: createdPlane.plane,
      enableWs: true,
      publicBaseUrl: "http://ui",
      scheduler: { intervalMs: 25 },
    });
    const base = `http://127.0.0.1:${port}`;
    const hostId = "durable-integration-host";

    const repository = await jsonRequest<{ id: string }>(base, "/api/v1/repositories", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "durable-integration-repo",
        url: repositoryPath,
        defaultBranch: "main",
      }),
    });
    const command = await jsonRequest<{ id: string }>(base, "/api/v1/commands", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "durable-integration-command",
        argv: [process.execPath, "-e", "console.log('durable-full-stack-output')"],
        appendPrompt: false,
        providerId: null,
      }),
    });
    await jsonRequest(base, `/api/v1/hosts/${hostId}/inventory`, 200, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositories: [
          {
            id: repository.id,
            path: repositoryPath,
            defaultBranch: "main",
            worktrees: [
              {
                id: "durable-integration-worktree",
                name: "durable-integration-worktree",
                path: worktreePath,
                labels: ["integration"],
              },
            ],
          },
        ],
        providerAccounts: [],
        commandProfiles: {},
      }),
    });

    const config = await loadDaemonConfig({
      env: {
        HARNESS_HOST_ID: hostId,
        HARNESS_API_URL: `${base}/ws`,
        HARNESS_LOG_LEVEL: "info",
      },
    });
    const daemon = await startDaemon({
      config,
      inventoryPollMs: 0,
      log: () => undefined,
      error: () => undefined,
    });
    stopDaemon = daemon.stop;

    const createdSession = await jsonRequest<{ id: string }>(base, "/api/v1/sessions", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        prompt: "unused by fixed command",
        target: { commandId: command.id },
        ref: "main",
        timeout: 30,
        queueTtlSeconds: 300,
        requiredLabels: ["integration"],
      }),
    });

    const terminal = await waitForTerminal(base, createdSession.id);
    expect(terminal.status).toBe("completed");
    const liveLogs = await jsonRequest<{ items: LogRecord[] }>(
      base,
      `/api/v1/sessions/${createdSession.id}/logs`,
      200,
    );
    expect(liveLogs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stream: "stdout",
          content: expect.stringContaining("durable-full-stack-output"),
        }),
        expect.objectContaining({ stream: "system", content: "Process exited with code 0" }),
      ]),
    );
    expect(await git(worktreePath, ["rev-parse", "HEAD"])).toBe(mainSha);

    await stopDaemon();
    stopDaemon = undefined;
    await server.close();
    server = undefined;

    const restartedPlane = await createControlPlane({
      tablePrefix: TABLE_PREFIX,
      publicBaseUrl: "http://ui",
    });
    storage = restartedPlane.storage;
    server = await startLocalServer({
      port: port + 1,
      plane: restartedPlane.plane,
      enableWs: false,
      publicBaseUrl: "http://ui",
    });
    const restartedBase = `http://127.0.0.1:${port + 1}`;
    const durableSession = await jsonRequest<{ status: string; exitCode: number | null }>(
      restartedBase,
      `/api/v1/sessions/${createdSession.id}`,
      200,
    );
    expect(durableSession).toMatchObject({ status: "completed", exitCode: 0 });
    const durableLogs = await jsonRequest<{ items: LogRecord[] }>(
      restartedBase,
      `/api/v1/sessions/${createdSession.id}/logs`,
      200,
    );
    expect(durableLogs.items.some((log) => log.content.includes("durable-full-stack-output"))).toBe(
      true,
    );
  });
});

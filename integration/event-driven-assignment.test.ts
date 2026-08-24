import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createControlPlane } from "../services/api/src/create-plane.ts";
import type { DynamoPlaneStorage } from "../services/api/src/db/plane-storage.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { loadDaemonConfig } from "../services/host-daemon/src/config.ts";
import { startDaemon } from "../services/host-daemon/src/start-daemon.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

const TABLE_PREFIX = process.env.HARNESS_DDB_PREFIX
  ? `${process.env.HARNESS_DDB_PREFIX}EventAssign`
  : "AutoHarnessEventAssign";
const TERMINAL_POLL_ATTEMPTS = 200;
const TERMINAL_POLL_INTERVAL_MS = 50;

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

async function waitForStatus(
  base: string,
  sessionId: string,
  allowed: readonly string[],
): Promise<{ status: string }> {
  let session = { status: "queued" };
  for (let attempt = 0; attempt < TERMINAL_POLL_ATTEMPTS; attempt++) {
    session = await jsonRequest<{ status: string }>(base, `/api/v1/sessions/${sessionId}`, 200);
    if (allowed.includes(session.status)) return session;
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_POLL_INTERVAL_MS));
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

async function startIsolatedStack(hostId: string) {
  root = mkdtempSync(join(tmpdir(), "ah-event-assign-"));
  const repositoryPath = join(root, "repo");
  const worktreePath = join(root, "worktree");
  mkdirSync(repositoryPath);
  await git(repositoryPath, ["init"]);
  await git(repositoryPath, ["config", "user.email", "integration@auto-harness.local"]);
  await git(repositoryPath, ["config", "user.name", "Auto Harness Integration"]);
  writeFileSync(join(repositoryPath, "README.md"), "event-driven assignment\n");
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, ["commit", "-m", "initial"]);
  await git(repositoryPath, ["branch", "-M", "main"]);

  const createdPlane = await createControlPlane({
    tablePrefix: TABLE_PREFIX,
    publicBaseUrl: "http://ui",
  });
  storage = createdPlane.storage;
  await storage.clearAll();

  const port = 27_000 + Math.floor(Math.random() * 1_000);
  server = await startLocalServer({
    port,
    plane: createdPlane.plane,
    enableWs: true,
    publicBaseUrl: "http://ui",
    scheduler: { intervalMs: 60_000 },
  });
  await server.scheduler.stop();
  const base = `http://127.0.0.1:${port}`;

  const repository = await jsonRequest<{ id: string }>(base, "/api/v1/repositories", 201, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "event-assign-repo",
      url: repositoryPath,
      defaultBranch: "main",
    }),
  });
  const command = await jsonRequest<{ id: string }>(base, "/api/v1/commands", 201, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "event-assign-command",
      argv: [process.execPath, "-e", "console.log('event-driven-assignment')"],
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
              id: "event-assign-worktree",
              name: "event-assign-worktree",
              path: worktreePath,
              labels: [],
            },
          ],
        },
      ],
      providerAccounts: [],
      commandProfiles: {},
    }),
  });

  return { base, commandId: command.id, hostId, repositoryId: repository.id, repositoryPath };
}

async function startTestDaemon(hostId: string, base: string) {
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
}

describe("event-driven assignment", () => {
  it("assigns on HTTP create without a cron sweep", async () => {
    const hostId = "event-assign-create-host";
    const { base, commandId, repositoryId } = await startIsolatedStack(hostId);
    await startTestDaemon(hostId, base);

    const created = await jsonRequest<{ id: string; status: string }>(
      base,
      "/api/v1/sessions",
      201,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId,
          prompt: "assign on create",
          target: { commandId },
          timeout: 60,
        }),
      },
    );
    const session = await waitForStatus(base, created.id, ["running", "completed"]);
    expect(["running", "completed"]).toContain(session.status);
    expect((await waitForStatus(base, created.id, ["completed"])).status).toBe("completed");
  });

  it("assigns a pre-queued session when the host registers", async () => {
    const hostId = "event-assign-register-host";
    const { base, commandId, repositoryId } = await startIsolatedStack(hostId);
    const created = await jsonRequest<{ id: string; status: string }>(
      base,
      "/api/v1/sessions",
      201,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId,
          prompt: "assign on register",
          target: { commandId },
          timeout: 60,
        }),
      },
    );
    expect(created.status).toBe("queued");
    expect(
      (await jsonRequest<{ status: string }>(base, `/api/v1/sessions/${created.id}`, 200)).status,
    ).toBe("queued");

    await startTestDaemon(hostId, base);
    expect((await waitForStatus(base, created.id, ["completed"])).status).toBe("completed");
  });
});

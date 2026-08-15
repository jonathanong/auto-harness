import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { LogRecord } from "../services/api/src/control-plane-types.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

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

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !ready(value); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

let root: string | undefined;
let server: RunningServer | undefined;
let daemon: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  if (daemon?.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon?.once("close", () => resolve()));
    daemon.kill("SIGKILL");
    await closed;
  }
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  daemon = undefined;
  server = undefined;
  root = undefined;
});

describe("packaged host daemon lifecycle", () => {
  it("delivers SIGTERM to the daemon and drains an in-flight CLI before exiting", async () => {
    root = mkdtempSync(join(tmpdir(), "ah-packaged-daemon-"));
    const repositoryPath = join(root, "repository");
    const worktreePath = join(root, "worktree");
    mkdirSync(repositoryPath);
    await git(repositoryPath, ["init"]);
    await git(repositoryPath, ["config", "user.email", "integration@auto-harness.local"]);
    await git(repositoryPath, ["config", "user.name", "Auto Harness Integration"]);
    writeFileSync(join(repositoryPath, "README.md"), "packaged daemon\n");
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "initial"]);
    await git(repositoryPath, ["branch", "-M", "main"]);

    const port = 22_000 + Math.floor(Math.random() * 1_000);
    server = await startLocalServer({
      port,
      useDynamo: false,
      enableWs: true,
      publicBaseUrl: "http://ui",
      scheduler: { intervalMs: 25 },
    });
    const base = `http://127.0.0.1:${port}`;
    const hostId = "packaged-systemd-host";

    const repository = await jsonRequest<{ id: string }>(base, "/api/v1/repositories", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "packaged-systemd-repository",
        url: repositoryPath,
        defaultBranch: "main",
      }),
    });
    const command = await jsonRequest<{ id: string }>(base, "/api/v1/commands", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "packaged-systemd-command",
        argv: [
          process.execPath,
          "-e",
          "setTimeout(() => console.log('packaged-drain-complete'), 750)",
        ],
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
                id: "packaged-systemd-worktree",
                name: "packaged-systemd-worktree",
                path: worktreePath,
                labels: ["systemd"],
              },
            ],
          },
        ],
        providerAccounts: [],
        commandProfiles: {},
      }),
    });

    daemon = spawn(
      process.execPath,
      ["services/host-daemon/bin/auto-harness-host-daemon.mjs", "start"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          HARNESS_HOST_ID: hostId,
          HARNESS_API_URL: base,
          HARNESS_LOG_LEVEL: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    daemon.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    daemon.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const daemonExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        daemon?.once("error", reject);
        daemon?.once("close", (code, signal) => resolve({ code, signal }));
      },
    );

    const registeredOutput = await waitFor(
      async () => output,
      (current) => current.includes(`agent ${hostId} registered`),
    );
    expect(registeredOutput).toContain(`agent ${hostId} registered`);

    const createdSession = await jsonRequest<{ id: string }>(base, "/api/v1/sessions", 201, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: repository.id,
        prompt: "not appended",
        target: { commandId: command.id },
        ref: "main",
        timeout: 10,
        queueTtlSeconds: 60,
        requiredLabels: ["systemd"],
      }),
    });

    const running = await waitFor(
      () => jsonRequest<{ status: string }>(base, `/api/v1/sessions/${createdSession.id}`, 200),
      (session) => session.status === "running",
    );
    expect(running.status).toBe("running");

    expect(daemon.kill("SIGTERM")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(daemon.exitCode).toBeNull();
    expect(daemon.signalCode).toBeNull();

    const terminal = await waitFor(
      () => jsonRequest<{ status: string }>(base, `/api/v1/sessions/${createdSession.id}`, 200),
      (session) => session.status === "completed" || session.status === "failed",
    );
    expect(terminal.status).toBe("completed");
    await expect(daemonExit).resolves.toEqual({ code: 0, signal: null });

    const logs = await jsonRequest<{ items: LogRecord[] }>(
      base,
      `/api/v1/sessions/${createdSession.id}/logs`,
      200,
    );
    expect(logs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stream: "stdout",
          content: expect.stringContaining("packaged-drain-complete"),
        }),
      ]),
    );
  });
});

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { startLocalServer } from "../services/api/src/local-server.ts";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
type RunningServer = Awaited<ReturnType<typeof startLocalServer>>;
type Host = {
  hostId: string;
  online: boolean;
  daemonStartedAt: string | null;
  restartCount: number;
  lastRestartDetectedAt: string | null;
};

let server: RunningServer | undefined;
let daemon: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  if (daemon?.exitCode === null && daemon.signalCode === null) {
    const closed = new Promise<void>((resolve) => daemon?.once("close", () => resolve()));
    daemon.kill("SIGKILL");
    await closed;
  }
  await server?.close();
  daemon = undefined;
  server = undefined;
});

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  expect(response.status, `${init?.method ?? "GET"} ${path}: ${text}`).toBe(200);
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

function launch(base: string, hostId: string) {
  const child = spawn(
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
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, exit, output: () => output };
}

describe("daemon restart observability integration", () => {
  it("distinguishes a packaged daemon relaunch from its initial registration", async () => {
    const port = 23_000 + Math.floor(Math.random() * 1_000);
    server = await startLocalServer({
      port,
      useDynamo: false,
      enableWs: true,
      publicBaseUrl: "http://ui",
      scheduler: { intervalMs: 25 },
    });
    const base = `http://127.0.0.1:${port}`;
    const hostId = "restart-observability-host";
    await request(base, `/api/v1/hosts/${hostId}/inventory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositories: [], providerAccounts: [], commandProfiles: {} }),
    });

    const first = launch(base, hostId);
    daemon = first.child;
    expect(
      await waitFor(
        async () => first.output(),
        (output) => output.includes(`agent ${hostId} registered`),
      ),
    ).toContain(`agent ${hostId} registered`);
    expect(
      (await request<{ items: Host[] }>(base, "/api/v1/hosts")).items.find(
        (host) => host.hostId === hostId,
      ),
    ).toMatchObject({ restartCount: 0, lastRestartDetectedAt: null });
    expect(first.child.kill("SIGTERM")).toBe(true);
    await expect(first.exit).resolves.toEqual({ code: 0, signal: null });
    await waitFor(
      () => request<{ items: Host[] }>(base, "/api/v1/hosts"),
      (response) => response.items.some((host) => host.hostId === hostId && !host.online),
    );

    const replacement = launch(base, hostId);
    daemon = replacement.child;
    expect(
      await waitFor(
        async () => replacement.output(),
        (output) => output.includes(`agent ${hostId} registered`),
      ),
    ).toContain(`agent ${hostId} registered`);
    const restarted = await waitFor(
      () => request<{ items: Host[] }>(base, "/api/v1/hosts"),
      (response) =>
        response.items.some((host) => host.hostId === hostId && host.restartCount === 1),
    );
    expect(restarted.items).toContainEqual(
      expect.objectContaining({
        hostId,
        daemonStartedAt: expect.any(String),
        restartCount: 1,
        lastRestartDetectedAt: expect.any(String),
      }),
    );
    expect(replacement.child.kill("SIGTERM")).toBe(true);
    await expect(replacement.exit).resolves.toEqual({ code: 0, signal: null });
  });
});

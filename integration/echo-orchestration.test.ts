import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { DaemonConfig } from "../services/host-daemon/src/config.ts";
import { startDaemon } from "../services/host-daemon/src/start-daemon.ts";
import { startLocalServer } from "../services/api/src/local-server.ts";
import type { LogRecord } from "../services/api/src/control-plane-types.ts";
import { runCommandOk } from "../scripts/lib/run-command.mts";

/**
 * Fast orchestration proof using the in-memory control plane: a real HTTP+WS
 * server, agent daemon, socket, git worktree, and subprocess. The companion
 * durable integration test covers DynamoDB, HTTP setup, scheduler dispatch,
 * and restart persistence. See docs/host-daemon-e2e-testing.md.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let root: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;
let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopDaemon?.();
  await closeServer?.();
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
  root = undefined;
  stopDaemon = undefined;
  closeServer = undefined;
});

// The assigned command runs in a PTY (PtyProcessRunner), which is POSIX-only:
// ruspty ships no Windows build, and PtyProcessRunner.run() throws before
// spawning on win32. See pty-runner.ts and pty-runner.real.test.ts.
describe.skipIf(process.platform === "win32")(
  "real orchestration: create -> assign -> run -> completed",
  () => {
    it("runs an argv-only command and retrieves its logs, JSON output, and artifact bytes", async () => {
      root = mkdtempSync(join(tmpdir(), "ah-echo-orchestration-"));
      const repo = join(root, "repo");
      const wt = join(root, "wt-1");
      mkdirSync(repo);
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "t@t"]);
      await git(repo, ["config", "user.name", "t"]);
      writeFileSync(join(repo, "README"), "echo\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "init"]);
      await git(repo, ["branch", "-M", "main"]);

      // Distinct band from services/api/src/local-server-options-coverage.test.ts's 19_000+ and
      // local-server-slack-worker.test.ts's 20_000+ — unit and integration tests now share one
      // Vitest worker pool (see vitest.config.ts's "unit"/"integration" projects), so their random
      // port ranges must not overlap.
      const port = 26000 + Math.floor(Math.random() * 2000);
      const server = await startLocalServer({
        port,
        useDynamo: false,
        enableWs: true,
        publicBaseUrl: "http://ui",
      });
      closeServer = server.close;
      await server.plane.putSessionLogSettings({
        version: 0,
        uploadMode: "always",
        batchMaxKb: 1,
        batchMaxLines: 1,
        batchMaxWaitMs: 1000,
      });
      expect(
        server.plane.createRepository({
          id: "demo",
          name: "demo",
          url: "https://example.test/demo.git",
          defaultBranch: "main",
        }).ok,
      ).toBe(true);
      server.plane.seedWorktree({
        id: "wt-1",
        name: "wt-1",
        hostId: "agent-echo",
        repositoryId: "demo",
        path: wt,
        labels: ["echo"],
        status: "idle",
        online: true,
      });

      const config: DaemonConfig = {
        hostId: "agent-echo",
        logLevel: "info",
        apiUrl: `http://127.0.0.1:${port}`,
        repositories: [
          {
            id: "demo",
            path: repo,
            defaultBranch: "main",
            worktrees: [{ id: "wt-1", name: "wt-1", path: wt, labels: ["echo"] }],
          },
        ],
        providerAccounts: [],
        commandProfiles: {},
      };

      const daemon = await startDaemon({
        config,
        sessionOutputsDir: join(root, "outputs"),
        childEnvSource: {
          ...process.env,
          HARNESS_DAEMON_LIVE_LOG_PORT: "off",
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
        },
        log: () => undefined,
        error: () => undefined,
      });
      stopDaemon = daemon.stop;
      await sleep(100);

      const commandResult = server.plane.createCommand({
        name: "echo-prompt",
        argv: [
          basename(process.execPath),
          "-e",
          "const fs=require('node:fs'); const path=require('node:path'); " +
            "console.log('hello world'); " +
            "fs.writeFileSync(process.env.HARNESS_OUTPUT_FILE, JSON.stringify({passed:true, values:[null,false,0]})); " +
            "fs.mkdirSync(path.join(process.env.HARNESS_ARTIFACTS_DIR,'reports')); " +
            "fs.writeFileSync(path.join(process.env.HARNESS_ARTIFACTS_DIR,'reports','report.txt'),'12 checks passed\\n');",
        ],
        appendPrompt: false,
        providerId: null,
      });
      if (!commandResult.ok) {
        throw new Error(commandResult.error);
      }

      const created = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repositoryId: "demo",
          prompt: "unused",
          target: { commandId: commandResult.command.id },
          timeout: 60,
          requiredLabels: ["echo"],
        }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };

      let session = server.plane.getSession(id);
      for (let i = 0; i < 100; i++) {
        session = server.plane.getSession(id);
        if (session?.status === "completed" || session?.status === "failed") {
          break;
        }
        await sleep(100);
      }
      expect(session?.status, JSON.stringify(session)).toBe("completed");

      const base = `http://127.0.0.1:${port}`;
      await expect
        .poll(
          async () => {
            const response = await fetch(`${base}/api/v1/sessions/${id}/output`);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            return response.json();
          },
          { timeout: 15_000, interval: 100 },
        )
        .toMatchObject({ state: "ready", output: { passed: true, values: [null, false, 0] } });
      const cliOutput = await runCommandOk(
        process.execPath,
        [
          fileURLToPath(new URL("../modules/client/src/cli/index.js", import.meta.url)),
          "session",
          "output",
          id,
          "--api-url",
          base,
          "--json",
        ],
        { env: { PATH: process.env.PATH, HOME: root } },
      );
      expect(JSON.parse(cliOutput)).toMatchObject({
        state: "ready",
        output: { passed: true, values: [null, false, 0] },
      });
      await expect
        .poll(async () => (await fetch(`${base}/api/v1/sessions/${id}/artifacts`)).json(), {
          timeout: 15_000,
          interval: 100,
        })
        .toMatchObject({ state: "ready", filename: "artifacts.tar.gz" });
      const artifacts = await (await fetch(`${base}/api/v1/sessions/${id}/artifacts`)).json();
      const download = await fetch(new URL(artifacts.downloadUrl, base));
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/gzip");
      const tar = gunzipSync(Buffer.from(await download.arrayBuffer()));
      let report: string | undefined;
      for (let offset = 0; offset + 512 <= tar.length;) {
        const header = tar.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
        if (!name) break;
        const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8);
        if (name === "reports/report.txt") {
          report = tar.subarray(offset + 512, offset + 512 + size).toString();
        }
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      expect(report).toBe("12 checks passed\n");

      // Real HTTP round trip, not just the in-process plane accessor.
      const logsRes = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${id}/logs`);
      expect(logsRes.status).toBe(200);
      const { items } = (await logsRes.json()) as { items: LogRecord[] };
      expect(items.some((l) => l.stream === "stdout" && l.content.includes("hello world"))).toBe(
        true,
      );
    });
  },
);

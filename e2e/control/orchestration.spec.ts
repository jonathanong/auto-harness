import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { fetchAgentHostConfig } from "../../services/agent/src/bootstrap.ts";
import { startAgentDaemon } from "../../services/agent/src/start-daemon.ts";
import { runCommandOk } from "../../scripts/lib/run-command.mts";

const API = "http://127.0.0.1:7430";

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runCommandOk("git", args, { cwd })).trim();
}

/**
 * The one e2e spec that runs a real agent daemon (real WebSocket, real
 * subprocess) instead of faking the agent side over REST like every other
 * e2e/*.spec.ts test — proves browser -> API -> WS -> daemon -> subprocess ->
 * WS -> API -> browser actually works end to end, not just each half
 * independently. See docs/agent-e2e-testing.md.
 */
test.describe("real orchestration", () => {
  test("browser-created session runs on a real agent and completes", async ({ page, request }) => {
    const hostId = `pw-orch-${test.info().parallelIndex}-${Date.now()}`;
    const repoId = `pw-orch-repo-${test.info().parallelIndex}-${Date.now()}`;
    const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;
    const root = mkdtempSync(join(tmpdir(), "pw-orchestration-"));
    const repo = join(root, "repo");
    const wt = join(root, wtId);
    let stopAgent: (() => Promise<void>) | undefined;

    try {
      mkdirSync(repo);
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "pw@pw"]);
      await git(repo, ["config", "user.name", "pw"]);
      writeFileSync(join(repo, "README"), "orchestration\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "init"]);
      await git(repo, ["branch", "-M", "main"]);

      await request.put(`${API}/api/v1/agents/${hostId}/config`, {
        data: {
          repositories: [
            {
              id: repoId,
              path: repo,
              defaultBranch: "main",
              worktrees: [{ id: wtId, name: wtId, path: wt, labels: ["echo"] }],
            },
          ],
          commandProfiles: {},
        },
      });
      const commandName = `echo-prompt-${test.info().parallelIndex}-${Date.now()}`;
      await request.post(`${API}/api/v1/commands`, {
        data: {
          name: commandName,
          argv: ["echo", "hello world"],
          appendPrompt: false,
          providerId: null,
        },
      });

      // Real bootstrap fetch (GET /api/v1/agents/:id/config), same as `pnpm local:agent start`.
      const config = await fetchAgentHostConfig({
        hostId,
        apiUrl: "ws://127.0.0.1:7430/ws",
        logLevel: "info",
      });
      const daemon = await startAgentDaemon({
        config,
        log: () => undefined,
        error: () => undefined,
      });
      stopAgent = daemon.stop;
      await new Promise((r) => setTimeout(r, 200));

      await page.goto("/sessions/new");
      await expect(page.getByTestId("create-session-target")).toBeEnabled({
        timeout: 15_000,
      });
      await page.getByTestId("create-session-repository-id").fill(repoId);
      await page.getByTestId("create-session-target").selectOption({ label: commandName });
      await page.getByTestId("create-session-prompt").fill("unused");
      await page.getByTestId("create-session-timeout").fill("30");
      await page.getByTestId("create-session-submit").click();

      await expect(page.getByTestId("page-session-detail")).toBeVisible({ timeout: 15_000 });
      const sessionId = await page.getByTestId("session-detail-id").innerText();

      // Local dev/test never auto-assigns — nudge the scheduler, same as every other spec here.
      let status = "queued";
      for (let i = 0; i < 100 && status !== "completed" && status !== "failed"; i++) {
        await request.post(`${API}/api/v1/scheduler/assign`);
        await new Promise((r) => setTimeout(r, 100));
        const res = await request.get(`${API}/api/v1/sessions/${sessionId}`);
        status = ((await res.json()) as { status: string }).status;
      }
      expect(status).toBe("completed");

      // The UI has no client-side polling — reload once to prove it reflects the real result.
      await page.reload();
      await expect(page.getByTestId("session-detail-status")).toContainText("completed");

      const logsRes = await request.get(`${API}/api/v1/sessions/${sessionId}/logs`);
      const { items } = (await logsRes.json()) as {
        items: Array<{ stream: string; content: string }>;
      };
      expect(items.some((l) => l.stream === "stdout" && l.content.includes("hello world"))).toBe(
        true,
      );
    } finally {
      await stopAgent?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

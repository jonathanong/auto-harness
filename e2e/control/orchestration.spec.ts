import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { fetchHostInventory } from "../../services/host-daemon/src/bootstrap.ts";
import { startDaemon } from "../../services/host-daemon/src/start-daemon.ts";
import { runCommandOk } from "../../scripts/lib/run-command.mts";
import { API_BASE, WS_BASE } from "../harness-endpoints.ts";

const API = API_BASE;

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
    let stopDaemon: (() => Promise<void>) | undefined;

    try {
      mkdirSync(repo);
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "pw@pw"]);
      await git(repo, ["config", "user.name", "pw"]);
      writeFileSync(join(repo, "README"), "orchestration\n");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "init"]);
      await git(repo, ["branch", "-M", "main"]);

      const repository = await request.post(`${API}/api/v1/repositories`, {
        data: { name: repoId, url: repo, defaultBranch: "main" },
      });
      expect(repository.ok()).toBe(true);
      const repositoryId = ((await repository.json()) as { id: string }).id;
      await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
        data: {
          repositories: [
            {
              id: repositoryId,
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
          argv: ["node", "-e", "setTimeout(() => console.log('hello world'), 1000)"],
          appendPrompt: false,
          providerId: null,
        },
      });

      // Real bootstrap fetch (GET /api/v1/hosts/:id/inventory), same as `pnpm local:daemon start`.
      const config = await fetchHostInventory({
        hostId,
        apiUrl: WS_BASE,
        logLevel: "info",
      });
      const daemon = await startDaemon({
        config,
        log: () => undefined,
        error: () => undefined,
      });
      stopDaemon = daemon.stop;
      await new Promise((r) => setTimeout(r, 200));

      await page.goto("/sessions/new");
      await expect(page.getByTestId("create-session-target")).toBeEnabled({
        timeout: 15_000,
      });
      await page.getByTestId("create-session-repository-id").selectOption(repositoryId);
      await page.getByTestId("create-session-target").selectOption({ label: commandName });
      await page.getByTestId("create-session-prompt").fill("unused");
      await page.getByTestId("create-session-timeout").selectOption("custom");
      await page.getByTestId("create-session-timeout-custom").fill("30");
      await page.getByTestId("create-session-submit").click();

      await expect(page.getByTestId("page-session-detail")).toBeVisible({ timeout: 15_000 });
      const sessionId = await page.getByTestId("session-detail-id").innerText();

      // Local dev/test never auto-assigns — nudge the scheduler, same as every other spec here.
      let status = "queued";
      let sawRunning = false;
      for (let i = 0; i < 100 && status !== "completed" && status !== "failed"; i++) {
        await request.post(`${API}/api/v1/scheduler/assign`);
        await new Promise((r) => setTimeout(r, 100));
        const res = await request.get(`${API}/api/v1/sessions/${sessionId}`);
        status = ((await res.json()) as { status: string }).status;
        if (status === "running" && !sawRunning) {
          sawRunning = true;
          await page.reload();
          await expect(page.getByTestId("status-running-live")).toHaveAttribute(
            "aria-label",
            "running, live",
          );
        }
      }
      expect(status).toBe("completed");
      expect(sawRunning).toBe(true);

      // The UI has no client-side polling — reload once to prove it reflects the real result.
      await page.reload();
      await expect(page.getByTestId("session-detail-status")).toContainText("completed");
      await expect(page.getByTestId("session-detail-duration")).toContainText(/\d+s/);
      await page.getByTestId("tab-details").click();
      await expect(page.getByTestId("session-detail-created").locator("time")).toHaveAttribute(
        "datetime",
      );
      await expect(page.getByTestId("session-detail-started").locator("time")).toHaveAttribute(
        "datetime",
      );
      await expect(page.getByTestId("session-detail-completed").locator("time")).toHaveAttribute(
        "datetime",
      );
      await expect(page.getByTestId("session-detail-exit-code")).toHaveText("0");
      await expect(page.getByTestId("session-detail-exit-code")).toHaveAttribute(
        "aria-label",
        "Exit code 0, success",
      );

      const logsRes = await request.get(`${API}/api/v1/sessions/${sessionId}/logs`);
      const { items } = (await logsRes.json()) as {
        items: Array<{ stream: string; content: string }>;
      };
      expect(items.some((l) => l.stream === "stdout" && l.content.includes("hello world"))).toBe(
        true,
      );
    } finally {
      await stopDaemon?.();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

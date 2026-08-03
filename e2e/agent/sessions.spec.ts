import { test, expect } from "@playwright/test";

const API = "http://127.0.0.1:7420";

test.describe("agent pane sessions", () => {
  test("sessions page loads", async ({ page }) => {
    await page.goto("/sessions");
    await expect(page.getByTestId("page-sessions")).toBeVisible();
    await expect(page.getByTestId("sessions-heading")).toHaveText("Sessions");
    await expect(page.getByTestId("session-filters")).toBeVisible();
  });

  test("clicking a session opens its detail page", async ({ page, request }) => {
    const repoId = `pw-agent-sess-repo-${test.info().parallelIndex}-${Date.now()}`;
    const wtId = `wt-${test.info().parallelIndex}-${Date.now()}`;

    const cfgRes = await request.get(`${API}/api/v1/agents/local-1/config`);
    const cfg = cfgRes.ok() ? await cfgRes.json() : { repositories: [], commandProfiles: {} };
    await request.put(`${API}/api/v1/agents/local-1/config`, {
      data: {
        repositories: [
          ...(cfg.repositories ?? []).filter((r: { id: string }) => r.id !== repoId),
          {
            id: repoId,
            path: `/tmp/${repoId}`,
            defaultBranch: "main",
            worktrees: [{ id: wtId, path: `/tmp/${repoId}/${wtId}`, labels: ["echo"] }],
          },
        ],
        commandProfiles: {
          ...cfg.commandProfiles,
          "echo-prompt": { argv: ["echo"], appendPrompt: true },
        },
      },
    });

    // Host config alone doesn't bring a worktree online — the scheduler only assigns to
    // online worktrees, and nothing here runs a real agent daemon. Register over REST
    // (the documented substitute for a live WebSocket connection in e2e tests).
    // A prior registration for "local-1" (e.g. an earlier retry, same server process)
    // is fine to leave in place — syncWorktreesFromHost marks any *new* worktree online
    // once the agentId has any active connection, regardless of this call's own outcome.
    await request.post(`${API}/api/v1/agent/messages`, {
      data: {
        type: "agent:register",
        agentId: "local-1",
        worktrees: [
          { id: wtId, repositoryId: repoId, path: `/tmp/${repoId}/${wtId}`, labels: ["echo"] },
        ],
        commandProfiles: ["echo-prompt"],
      },
    });

    const created = await request.post(`${API}/api/v1/sessions`, {
      data: {
        repositoryId: repoId,
        prompt: `hello-${wtId}`,
        commandProfile: "echo-prompt",
        timeout: 30,
        requiredLabels: ["echo"],
      },
    });
    const { id } = (await created.json()) as { id: string };
    await request.post(`${API}/api/v1/scheduler/assign`);

    await page.goto("/sessions");
    await expect(page.getByTestId(`session-link-${id}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`session-link-${id}`).click();

    await expect(page).toHaveURL(new RegExp(`/sessions/${id}$`));
    await expect(page.getByTestId("session-detail-id")).toHaveText(id);
    await expect(page.getByTestId("session-detail-status")).toBeVisible();
  });
});

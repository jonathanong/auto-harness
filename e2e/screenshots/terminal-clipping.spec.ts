import { expect, test } from "@playwright/test";

import { API_BASE } from "../harness-endpoints.ts";
import { closeSocket, connectHost, CONTROL_BASE, logFrame, shot } from "./lib.ts";

const LINE_COUNT = 60;

/**
 * Regression coverage for the terminal-clipping fix (design review finding #1): the session
 * log viewer used to hardcode a 40-row xterm grid inside a shorter, `overflow-hidden` box, so
 * the bottom rows were rendered but physically invisible. Seeds numbered lines (not ANSI noise —
 * see docs/e2e.md) so a missing tail line is self-evident in the screenshot, and measures the
 * rendered terminal's height against its host container to lock the fix in as an assertion, not
 * just a visual.
 */
test.describe("terminal clipping", () => {
  test("renders every line within the visible viewport, nothing clipped", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-clip-host-${suffix}`;
    const repoId = `pw-clip-repo-${suffix}`;
    const worktreeId = `pw-clip-worktree-${suffix}`;
    const commandName = `pw-clip-command-${suffix}`;
    let host: Awaited<ReturnType<typeof connectHost>> | undefined;

    try {
      const inventory = await request.put(`${API_BASE}/api/v1/hosts/${hostId}/inventory`, {
        data: {
          repositories: [
            {
              id: repoId,
              path: `/tmp/${repoId}`,
              defaultBranch: "main",
              worktrees: [
                { id: worktreeId, name: worktreeId, path: `/tmp/${worktreeId}`, labels: [] },
              ],
            },
          ],
          commandProfiles: {},
        },
      });
      expect(inventory.ok()).toBe(true);
      host = await connectHost(hostId, repoId, worktreeId);

      const commandResponse = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const commandId = ((await commandResponse.json()) as { id: string }).id;
      const created = await request.post(`${API_BASE}/api/v1/sessions`, {
        data: {
          repositoryId: repoId,
          prompt: "terminal clipping fixture",
          target: { commandId },
          timeout: 30,
        },
      });
      const session = (await created.json()) as { id: string };
      await request.post(`${API_BASE}/api/v1/scheduler/assign`);
      const assignment = await host.assignment;
      host.socket.send(
        JSON.stringify({
          type: "session:ack",
          sessionId: assignment.sessionId,
          worktreeId,
          attemptId: assignment.attemptId,
        }),
      );
      for (let i = 1; i <= LINE_COUNT; i++) {
        host.socket.send(logFrame(session.id, `line ${String(i).padStart(3, "0")}`, i));
      }

      await page.goto(`${CONTROL_BASE}/sessions/${session.id}`);
      await expect(page.getByTestId("session-logs")).toBeVisible();
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        `line ${String(LINE_COUNT).padStart(3, "0")}`,
      );

      await page.getByTestId("session-logs").scrollIntoViewIfNeeded();
      await shot(page, "terminal-clipping");

      const geometry = await page.getByTestId("session-logs").evaluate((container) => {
        const rendered = container.querySelector<HTMLElement>(".xterm-screen");
        return {
          containerHeight: container.clientHeight,
          renderedHeight: rendered?.clientHeight ?? 0,
        };
      });
      expect(geometry.renderedHeight).toBeLessThanOrEqual(geometry.containerHeight);
    } finally {
      if (host) await closeSocket(host.socket);
    }
  });
});

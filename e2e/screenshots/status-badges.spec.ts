import { expect, test } from "@playwright/test";

import { API_BASE } from "../harness-endpoints.ts";
import { closeSocket, connectHost, CONTROL_BASE, shot } from "./lib.ts";

/**
 * Design-review finding #2 (worktree status split into `WorktreeStatusBadge`, gaining real
 * colors for idle/busy/error) and #3 (`timed_out` split off from `queued`'s color). Drives real
 * status transitions through the same wire protocol the host daemon uses
 * (services/host-daemon/src/daemon-loop.ts's `session:status` message), rather than mocking —
 * a worktree only exists as "busy" for the duration of a live session assignment, and
 * `timed_out` only exists after the daemon reports it, so both need the real flow, not a fixture.
 */
test.describe("status badges", () => {
  test("worktree busy/idle and session timed_out/queued render with distinct colors", async ({
    page,
    request,
  }) => {
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-status-host-${suffix}`;
    const repoId = `pw-status-repo-${suffix}`;
    const busyWorktreeId = `pw-status-busy-wt-${suffix}`;
    const idleWorktreeId = `pw-status-idle-wt-${suffix}`;
    const commandName = `pw-status-command-${suffix}`;
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
                {
                  id: busyWorktreeId,
                  name: busyWorktreeId,
                  path: `/tmp/${busyWorktreeId}`,
                  labels: [],
                },
                {
                  id: idleWorktreeId,
                  name: idleWorktreeId,
                  path: `/tmp/${idleWorktreeId}`,
                  labels: [],
                },
              ],
            },
          ],
          commandProfiles: {},
        },
      });
      expect(inventory.ok()).toBe(true);
      host = await connectHost(hostId, repoId, busyWorktreeId);

      const commandResponse = await request.post(`${API_BASE}/api/v1/commands`, {
        data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      const commandId = ((await commandResponse.json()) as { id: string }).id;
      const timedOutSession = await request.post(`${API_BASE}/api/v1/sessions`, {
        data: {
          repositoryId: repoId,
          prompt: "status badge fixture — will time out",
          target: { commandId },
          timeout: 30,
        },
      });
      const timedOutSessionId = ((await timedOutSession.json()) as { id: string }).id;
      await request.post(`${API_BASE}/api/v1/scheduler/assign`);
      const assignment = await host.assignment;
      host.socket.send(
        JSON.stringify({
          type: "session:ack",
          sessionId: assignment.sessionId,
          worktreeId: busyWorktreeId,
          attemptId: assignment.attemptId,
        }),
      );

      // The worktree only reads "busy" while this session is assigned and unfinished.
      await page.goto(`${CONTROL_BASE}/worktrees`);
      await expect(page.getByTestId(`worktree-link-${busyWorktreeId}`)).toBeVisible({
        timeout: 15_000,
      });
      await shot(page, "status-badges-worktrees");

      // No repository/worktree ever exists for this one, so it stays queued.
      const queuedSession = await request.post(`${API_BASE}/api/v1/sessions`, {
        data: {
          repositoryId: repoId,
          prompt: "status badge fixture — stays queued",
          target: { commandId },
          timeout: 30,
        },
      });
      expect(queuedSession.ok()).toBe(true);

      // Mirrors services/host-daemon/src/daemon-loop.ts's real "session:status" wire message —
      // the same message a real daemon sends after its own timeout enforcement fires.
      host.socket.send(
        JSON.stringify({
          type: "session:status",
          sessionId: timedOutSessionId,
          worktreeId: busyWorktreeId,
          attemptId: assignment.attemptId,
          status: "timed_out",
          exitCode: null,
        }),
      );

      await page.goto(`${CONTROL_BASE}/sessions`);
      const timedOutRow = page.locator(`[data-pw="session-row-${timedOutSessionId}"]`);
      await expect(timedOutRow.getByText("timed_out", { exact: false })).toBeVisible({
        timeout: 15_000,
      });
      await shot(page, "status-badges-sessions");
    } finally {
      if (host) await closeSocket(host.socket);
    }
  });
});

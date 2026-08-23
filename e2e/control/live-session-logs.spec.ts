/* eslint-disable max-lines -- one end-to-end flow owns the host, viewer, and terminal lifecycle. */
import { expect, test } from "@playwright/test";
import { createCatalogRepository } from "../local-1-host.ts";

const API = `http://127.0.0.1:${7430 + portOffset()}`;

test.describe("live session logs", () => {
  test("production browser tails a real API WebSocket and shows lifecycle state", async ({
    page,
    request,
  }) => {
    await page.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes("/ws/viewer")) {
            (window as typeof window & { testViewerSocket?: WebSocket }).testViewerSocket = this;
          }
        }
      };
    });
    const suffix = `${test.info().parallelIndex}-${Date.now()}`;
    const hostId = `pw-live-host-${suffix}`;
    const repoId = await createCatalogRepository(request, `pw-live-repo-${suffix}`);
    const worktreeId = `pw-live-worktree-${suffix}`;
    const commandName = `pw-live-command-${suffix}`;
    let host: Awaited<ReturnType<typeof connectHost>> | undefined;

    try {
      const inventory = await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
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
      const commandResponse = await request.post(`${API}/api/v1/commands`, {
        data: { name: commandName, argv: ["echo"], appendPrompt: true, providerId: null },
      });
      expect(commandResponse.ok()).toBe(true);
      const commandId = ((await commandResponse.json()) as { id: string }).id;
      const created = await request.post(`${API}/api/v1/sessions`, {
        data: {
          repositoryId: repoId,
          prompt: "tail browser logs",
          target: { commandId },
          timeout: 30,
        },
      });
      expect(created.ok()).toBe(true);
      const session = (await created.json()) as { id: string };
      await request.post(`${API}/api/v1/scheduler/assign`);
      const assignment = await host.assignment;
      expect(assignment.sessionId).toBe(session.id);
      host.socket.send(
        JSON.stringify({
          type: "session:ack",
          sessionId: assignment.sessionId,
          worktreeId,
          attemptId: assignment.attemptId,
        }),
      );
      host.socket.send(logFrame(session.id, "history from the real host socket", 1));

      const ticketResponse = page.waitForResponse((response) =>
        response.url().endsWith("/api/v1/auth/viewer-ticket"),
      );
      await page.goto(`/sessions/${session.id}`);
      expect((await ticketResponse).status()).toBe(200);
      await expect(page.getByTestId("session-logs-live-tail")).toBeVisible();
      await expect(page.getByTestId("session-terminal-controls")).toBeVisible();
      await expect(page.getByTestId("session-logs-empty")).toHaveCount(0);
      await expect(page.getByTestId("session-logs-live-error")).toHaveCount(0);
      await expect(page.getByTestId("session-logs-live-state")).toContainText("Live — running");
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        "history from the real host socket",
      );
      await expect(page.getByTestId("session-logs").locator(".xterm-screen")).toBeVisible();

      await page.evaluate(() => {
        (window as typeof window & { testViewerSocket?: WebSocket }).testViewerSocket?.close(4001);
      });
      await expect(page.getByTestId("session-logs-reconnect-banner")).toContainText(
        "Real-time updates paused",
      );
      const reconnectTicket = page.waitForResponse((response) =>
        response.url().endsWith("/api/v1/auth/viewer-ticket"),
      );
      await page.getByTestId("session-logs-reconnect-now").click();
      expect((await reconnectTicket).status()).toBe(200);
      await expect(page.getByTestId("session-logs-live-state")).toContainText("Live — running");

      host.socket.send(logFrame(session.id, "\u001b[31mANSI red output\u001b[0m", 2));
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        "ANSI red output",
      );
      host.socket.send(logFrame(session.id, "live browser tail", 3));
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        "live browser tail",
      );
      host.socket.send(logFrame(session.id, "Process exited with code 0", 4, "system"));
      host.socket.send(
        logFrame(session.id, "Session completed at 2026-08-01T12:05:30.000Z", 5, "system"),
      );
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        "[system] Process exited with code 0",
      );
      await expect(page.getByTestId("session-terminal-transcript")).toContainText(
        "[system] Session completed at 2026-08-01T12:05:30.000Z",
      );

      await page.getByTestId("session-logs").click();
      await page.keyboard.press("Control+f");
      await expect(page.getByTestId("session-terminal-search")).toBeFocused();
      await page.getByTestId("session-terminal-search").fill("ANSI red output");
      await page.getByTestId("session-terminal-search-next").click();
      await expect(page.getByTestId("session-terminal-search-result")).toHaveText("Match found");
      await page.getByTestId("session-terminal-search-previous").click();

      await expect(page.getByTestId("session-terminal-font-size")).toHaveText("13px");
      await page.getByTestId("session-terminal-font-increase").click();
      await expect(page.getByTestId("session-terminal-font-size")).toHaveText("14px");
      await page.getByTestId("session-terminal-font-decrease").click();
      await expect(page.getByTestId("session-terminal-font-size")).toHaveText("13px");
      await page.getByTestId("session-terminal-fullscreen").click();
      await expect(page.getByTestId("session-terminal")).toHaveAttribute("data-fullscreen", "true");
      await page.getByTestId("session-terminal-fullscreen").click();
      await expect(page.getByTestId("session-terminal")).toHaveAttribute(
        "data-fullscreen",
        "false",
      );

      const download = page.waitForEvent("download");
      await page.getByTestId("session-terminal-download").click();
      expect((await download).suggestedFilename()).toBe(`${session.id}.txt`);

      host.socket.send(
        JSON.stringify({
          type: "session:status",
          sessionId: assignment.sessionId,
          worktreeId,
          attemptId: assignment.attemptId,
          status: "completed",
          exitCode: 0,
        }),
      );
      await expect(page.getByTestId("session-logs-live-state")).toHaveText("completed");
    } finally {
      if (host) await closeSocket(host.socket);
    }
  });
});

async function connectHost(
  hostId: string,
  repositoryId: string,
  worktreeId: string,
): Promise<{
  socket: WebSocket;
  assignment: Promise<{ sessionId: string; attemptId: string }>;
}> {
  const socket = new WebSocket(API.replace("http:", "ws:") + "/ws");
  const assignment = new Promise<{ sessionId: string; attemptId: string }>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        sessionId?: string;
        attemptId?: string;
      };
      if (message.type === "session:assign" && message.sessionId && message.attemptId) {
        resolve({ sessionId: message.sessionId, attemptId: message.attemptId });
      }
    });
    socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "host:register",
          hostId,
          worktrees: [
            {
              id: worktreeId,
              name: worktreeId,
              repositoryId,
              path: `/tmp/${worktreeId}`,
              labels: [],
            },
          ],
          commandProfiles: [],
          runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        }),
      );
      resolve();
    });
    socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
  });
  return { socket, assignment };
}

function logFrame(
  sessionId: string,
  content: string,
  seq: number,
  stream: "stdout" | "system" = "stdout",
): string {
  return JSON.stringify({
    type: "session:log",
    sessionId,
    stream,
    content: `${content}\r\n`,
    timestamp: new Date().toISOString(),
    seq,
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close();
  });
}

function portOffset(): number {
  const value = process.env.HARNESS_E2E_PORT_OFFSET;
  return value ? Number(value) : 0;
}

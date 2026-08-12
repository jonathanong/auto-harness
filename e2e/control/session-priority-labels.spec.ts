import { expect, test } from "@playwright/test";

const API = `http://127.0.0.1:${7430 + Number(process.env.HARNESS_E2E_PORT_OFFSET ?? 0)}`;

test("creates and lists a prioritized, label-constrained session", async ({ page, request }) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const hostId = `pw-label-host-${suffix}`;
  const repoId = `pw-label-repo-${suffix}`;
  const worktreeId = `pw-label-worktree-${suffix}`;
  let socket: WebSocket | undefined;

  try {
    const repository = await request.post(`${API}/api/v1/repositories`, {
      data: { name: repoId, url: `/tmp/${repoId}`, defaultBranch: "main" },
    });
    expect(repository.ok()).toBe(true);
    const repositoryId = ((await repository.json()) as { id: string }).id;
    const inventory = await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
      data: {
        repositories: [
          {
            id: repositoryId,
            path: `/tmp/${repoId}`,
            defaultBranch: "main",
            worktrees: [
              {
                id: worktreeId,
                name: worktreeId,
                path: `/tmp/${worktreeId}`,
                labels: ["codex", "gpu"],
              },
            ],
          },
        ],
        commandProfiles: {},
      },
    });
    expect(inventory.ok()).toBe(true);
    socket = await connectHost(hostId, repositoryId, worktreeId);
    const command = await request.post(`${API}/api/v1/commands`, {
      data: {
        name: `pw-label-command-${suffix}`,
        argv: ["echo"],
        appendPrompt: true,
        providerId: null,
      },
    });
    expect(command.ok()).toBe(true);
    const commandId = ((await command.json()) as { id: string }).id;

    await page.goto("/sessions/new");
    await page.getByTestId("create-session-repository-id").selectOption(repositoryId);
    await page.getByTestId("create-session-target").selectOption(`command:${commandId}`);
    await page.getByTestId("create-session-prompt").fill("run urgent labeled work");
    await page.getByTestId("create-session-priority").fill("83");
    await expect(page.getByTestId("create-session-priority-value")).toHaveText("83 (critical)");
    await expect(page.getByTestId("create-session-labels")).toBeVisible();
    await expect(page.getByTestId("create-session-labels-empty")).toHaveCount(0);
    await page.getByText("codex", { exact: true }).click();
    await page.getByText("gpu", { exact: true }).click();
    await expect(page.getByTestId("create-session-label-codex")).toBeChecked();
    await expect(page.getByTestId("create-session-label-gpu")).toBeChecked();
    const createRequest = page.waitForRequest(
      (candidate) => candidate.url().endsWith("/api/v1/sessions") && candidate.method() === "POST",
    );
    const createResponse = page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/v1/sessions") && candidate.request().method() === "POST",
    );
    await page.getByTestId("create-session-submit").click();
    const posted = (await createRequest).postDataJSON();
    expect(posted).toMatchObject({
      priority: 83,
      requiredLabels: ["codex", "gpu"],
      source: "ui",
    });
    const sessionId = ((await (await createResponse).json()) as { id: string }).id;
    await expect(page).toHaveURL(`/sessions/${encodeURIComponent(sessionId)}`);
    await expect(page.getByTestId("page-session-detail")).toBeVisible();

    await page.goto("/sessions");
    await expect(page.getByTestId(`session-priority-${sessionId}`)).toHaveText("83");
    await expect(page.getByTestId(`session-labels-${sessionId}`)).toContainText("codex");
    await expect(page.getByTestId(`session-labels-${sessionId}`)).toContainText("gpu");
  } finally {
    if (socket) await closeSocket(socket);
  }
});

async function connectHost(hostId: string, repositoryId: string, worktreeId: string) {
  const socket = new WebSocket(API.replace("http:", "ws:") + "/ws");
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; message?: string };
      if (message.type === "host:registered") resolve();
      if (message.type === "error") reject(new Error(message.message));
    });
    socket.addEventListener("error", () => reject(new Error("host WebSocket failed")));
    socket.addEventListener("open", () =>
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
              labels: ["codex", "gpu"],
            },
          ],
          commandProfiles: [],
        }),
      ),
    );
  });
  return socket;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
    socket.close();
  });
}

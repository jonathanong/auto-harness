import { expect, test, type APIRequestContext } from "@playwright/test";

import { API_BASE } from "../harness-endpoints.ts";

async function createSession(request: APIRequestContext): Promise<string> {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const repository = await request.post(`${API_BASE}/api/v1/repositories`, {
    data: {
      name: `output-states-${suffix}`,
      url: `https://example.test/output-${suffix}.git`,
      defaultBranch: "main",
    },
  });
  expect(repository.status()).toBe(201);
  const command = await request.post(`${API_BASE}/api/v1/commands`, {
    data: {
      name: `output-states-${suffix}`,
      argv: ["echo"],
      appendPrompt: false,
      providerId: null,
    },
  });
  expect(command.status()).toBe(201);
  const session = await request.post(`${API_BASE}/api/v1/sessions`, {
    data: {
      repositoryId: (await repository.json()).id,
      prompt: "output states",
      target: { commandId: (await command.json()).id },
      timeout: 30,
    },
  });
  expect(session.status()).toBe(201);
  return (await session.json()).id;
}

const readyArtifacts = {
  state: "ready",
  downloadUrl: "https://example.test/unused-download",
  expiresAt: "2026-10-08T15:00:00.000Z",
  capturedAt: "2026-10-08T14:00:00.000Z",
  contentType: "application/gzip",
  filename: "artifacts.tar.gz",
  compressedBytes: 123,
  sha256: "a".repeat(64),
};

test.describe("session output browser states", () => {
  test("shows independent capture errors and a failed fresh download request", async ({
    page,
    request,
  }) => {
    const id = await createSession(request);
    await page.route(`**/api/v1/sessions/${id}/output`, (route) =>
      route.fulfill({
        json: {
          state: "error",
          error: { code: "INVALID_JSON", message: "Output contains invalid JSON" },
        },
      }),
    );
    let downloads = 0;
    await page.route(`**/api/v1/sessions/${id}/artifacts`, (route) => {
      downloads += 1;
      return downloads === 1
        ? route.fulfill({ json: readyArtifacts })
        : route.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
    });
    await page.goto(`/sessions/${id}?tab=outputs`);
    await expect(page.getByTestId("session-outputs")).toBeVisible();
    await expect(page.getByTestId("session-output-error")).toContainText("INVALID_JSON");
    await expect(page.getByTestId("session-artifacts-ready")).toContainText("artifacts.tar.gz");
    await page.getByTestId("session-artifacts-download").click();
    await expect(page.getByTestId("session-artifacts-download-error")).toContainText("503");
  });

  test("recovers transport failures and safely reports JSON too deep to format", async ({
    page,
    request,
  }) => {
    const id = await createSession(request);
    let retry = false;
    const deepJson = `{"state":"ready","capturedAt":"now","output":${"[".repeat(20_000)}0${"]".repeat(20_000)}}`;
    await page.route(`**/api/v1/sessions/${id}/output`, (route) =>
      retry
        ? route.fulfill({ contentType: "application/json", body: deepJson })
        : route.fulfill({ status: 503, json: {} }),
    );
    await page.route(`**/api/v1/sessions/${id}/artifacts`, (route) =>
      retry ? route.fulfill({ json: { state: "none" } }) : route.fulfill({ status: 503, json: {} }),
    );
    await page.goto(`/sessions/${id}?tab=outputs`);
    await expect(page.getByTestId("session-output-fetch-error")).toContainText("503");
    await expect(page.getByTestId("session-artifacts-fetch-error")).toContainText("503");
    retry = true;
    await page.getByTestId("session-output-refresh").click();
    await expect(page.getByTestId("session-output-render-error")).toContainText(
      "too deeply nested",
    );
    await expect(page.getByTestId("session-output-fetch-error")).toHaveCount(0);
    await expect(page.getByTestId("session-artifacts-fetch-error")).toHaveCount(0);
  });

  test("bounds automatic polling and lets the user refresh after it pauses", async ({
    page,
    request,
  }) => {
    const id = await createSession(request);
    let polls = 0;
    let ready = false;
    await page.route(`**/api/v1/sessions/${id}/output`, (route) => {
      polls += 1;
      return route.fulfill({
        json: ready ? { state: "ready", output: false, capturedAt: "now" } : { state: "pending" },
      });
    });
    await page.route(`**/api/v1/sessions/${id}/artifacts`, (route) =>
      route.fulfill({ json: { state: "none" } }),
    );
    await page.clock.install();
    await page.goto(`/sessions/${id}?tab=outputs`);
    await expect(page.getByTestId("session-output-refresh")).toBeVisible();
    await expect.poll(() => polls).toBe(1);
    for (let count = 2; count <= 12; count += 1) {
      await page.clock.runFor(5_000);
      await expect.poll(() => polls).toBe(count);
    }
    await expect(page.getByTestId("session-output-poll-paused")).toBeVisible();
    await page.clock.runFor(15_000);
    expect(polls).toBe(12);
    ready = true;
    await page.getByTestId("session-output-refresh").click();
    await expect(page.getByTestId("session-output-ready")).toContainText("false");
    await expect(page.getByTestId("session-output-poll-paused")).toHaveCount(0);
  });
});

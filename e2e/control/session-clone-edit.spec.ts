import { expect, test } from "@playwright/test";

const API = `http://127.0.0.1:${7430 + Number(process.env.HARNESS_E2E_PORT_OFFSET ?? 0)}`;

test("opens Clone & Edit without creating and submits only replayable source inputs", async ({
  page,
  request,
}) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const repository = await (
    await request.post(`${API}/api/v1/repositories`, {
      data: {
        name: `pw-clone-edit-${suffix}`,
        url: `/tmp/pw-clone-edit-${suffix}`,
        defaultBranch: "main",
      },
    })
  ).json();
  const primary = await (
    await request.post(`${API}/api/v1/commands`, {
      data: { name: `pw-clone-primary-${suffix}`, argv: ["echo"], providerId: null },
    })
  ).json();
  const fallback = await (
    await request.post(`${API}/api/v1/commands`, {
      data: { name: `pw-clone-fallback-${suffix}`, argv: ["echo"], providerId: null },
    })
  ).json();
  const prompt = `clone prompt ${suffix} with spaces and ? query-like content`;
  const source = await (
    await request.post(`${API}/api/v1/sessions`, {
      data: {
        repositoryId: repository.id,
        prompt,
        target: { commandId: primary.id },
        fallbacks: [{ commandId: fallback.id }],
        queueTtlSeconds: 321,
        timeout: 123,
        priority: 67,
        requiredLabels: ["clone-label"],
        ref: "feature/clone-edit",
        concurrencyId: `excluded-${suffix}`,
        metadata: { private: "excluded metadata" },
        source: "api",
      },
    })
  ).json();
  await request.post(`${API}/api/v1/sessions/${source.id}/cancel`);

  const creates: unknown[] = [];
  page.on("request", (outbound) => {
    if (outbound.method() === "POST" && outbound.url().endsWith("/api/v1/sessions")) {
      creates.push(outbound.postDataJSON());
    }
  });
  await page.goto(`/sessions/${source.id}`);
  await page.getByTestId("session-clone-edit").click();
  await expect(page).toHaveURL(new RegExp(`/sessions/new[?]cloneFrom=${source.id}$`));
  expect(page.url()).not.toContain(encodeURIComponent(prompt));
  await expect(page.getByTestId("session-clone-source")).toContainText(source.id);
  await expect(page.getByTestId("create-session-repository-id")).toHaveValue(repository.id);
  await expect(page.getByTestId("create-session-prompt")).toHaveValue(prompt);
  await expect(page.getByTestId("create-session-target")).toHaveValue(`command:${primary.id}`);
  await expect(page.getByTestId("create-session-fallback-select-0")).toHaveValue(
    `command:${fallback.id}`,
  );
  await expect(page.getByTestId("create-session-queue-ttl")).toHaveValue("321");
  await expect(page.getByTestId("create-session-timeout")).toHaveValue("custom");
  await expect(page.getByTestId("create-session-timeout-custom")).toHaveValue("123");
  await expect(page.getByTestId("create-session-priority")).toHaveValue("67");
  await expect(page.getByTestId("create-session-label-clone-label")).toBeChecked();
  await expect(page.getByTestId("create-session-ref")).toHaveValue("feature/clone-edit");
  await expect(page.getByTestId("create-session-concurrency-id")).toHaveValue("");
  expect(creates).toEqual([]);

  await page.getByTestId("nav-session-new").click();
  await expect(page).toHaveURL(/\/sessions\/new$/);
  await expect(page.getByTestId("session-clone-source")).toHaveCount(0);
  await expect(page.getByTestId("create-session-repository-id")).toBeVisible();
  await expect(page.getByTestId("create-session-prompt")).toHaveValue("");
  await page.goto(`/sessions/${source.id}`);
  await page.getByTestId("session-clone-edit").click();

  await page.getByTestId("create-session-prompt").fill(`${prompt} edited`);
  await page.getByTestId("create-session-submit").click();
  await expect(page).toHaveURL(/\/sessions\/[^/?]+(?:\?toast=.*)?$/);
  await expect(page.getByTestId("toast")).toContainText("Session queued.");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toEqual({
    repositoryId: repository.id,
    prompt: `${prompt} edited`,
    target: { commandId: primary.id },
    fallbacks: [{ commandId: fallback.id }],
    queueTtlSeconds: 321,
    timeout: 123,
    priority: 67,
    requiredLabels: ["clone-label"],
    ref: "feature/clone-edit",
    source: "ui",
  });
});

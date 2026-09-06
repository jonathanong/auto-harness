import { expect, test } from "@playwright/test";

import { filamentsCreateSessionBody } from "../../integration/filaments-session-contract.ts";

const API = `http://127.0.0.1:${7430 + Number(process.env.HARNESS_E2E_PORT_OFFSET ?? 0)}`;

test("renders a durable Filaments webhook session created through the public API", async ({
  page,
  request,
}) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const repositoryName = `filaments-consumer-${suffix}`;
  const repositoryResponse = await request.post(`${API}/api/v1/repositories`, {
    data: {
      name: repositoryName,
      url: `/tmp/${repositoryName}`,
      defaultBranch: "main",
    },
  });
  expect(repositoryResponse.status()).toBe(201);
  const repositoryId = ((await repositoryResponse.json()) as { id: string }).id;

  const commandResponse = await request.post(`${API}/api/v1/commands`, {
    data: {
      name: `filaments-consumer-command-${suffix}`,
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    },
  });
  expect(commandResponse.status()).toBe(201);
  const commandId = ((await commandResponse.json()) as { id: string }).id;
  const prompt = `Filaments webhook prompt ${suffix}`;
  const concurrencyId = `filaments-fix-${suffix}`;

  const createResponse = await request.post(`${API}/api/v1/sessions`, {
    data: filamentsCreateSessionBody({ repositoryId, commandId, prompt, concurrencyId }),
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { created: boolean; id: string };
  expect(created.created).toBe(true);
  expect(created.id).toMatch(/^sess-[0-9a-f]{8}$/);

  const durableResponse = await request.get(`${API}/api/v1/sessions/${created.id}`);
  expect(durableResponse.status()).toBe(200);
  await expect(durableResponse.json()).resolves.toMatchObject({
    concurrencyId,
    metadata: { issueNumber: 9366, repository: "jonathanong/filaments" },
    priority: 20,
    prompt,
    ref: "refs/heads/main",
    requiredLabels: ["filaments"],
    source: "webhook",
    status: "queued",
  });

  await page.goto(
    `/sessions?repositoryId=${repositoryId}&source=webhook&concurrencyId=${concurrencyId}`,
  );
  const row = page.getByTestId(`session-row-${created.id}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("session-source-webhook")).toHaveText("webhook");
  await expect(page.getByTestId(`session-repository-${created.id}`)).toHaveText(repositoryName);
  await expect(page.getByTestId(`session-priority-${created.id}`)).toHaveText("20");
  await expect(page.getByTestId(`session-labels-${created.id}`)).toHaveText("filaments");
  await expect(row).toContainText(concurrencyId);
  await expect(row).toContainText(prompt);

  await page.getByTestId(`session-link-${created.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${created.id}$`));
  await expect(page.getByTestId("session-detail-source")).toHaveText("webhook");
  await page.getByTestId("tab-details").click();
  await expect(page.getByTestId("session-detail-priority")).toHaveText("20");
  await expect(page.getByTestId("session-detail-concurrency-id")).toHaveText(concurrencyId);
  await page.getByTestId("tab-prompts").click();
  await expect(page.getByTestId("session-detail-prompt-content")).toHaveText(prompt);
});

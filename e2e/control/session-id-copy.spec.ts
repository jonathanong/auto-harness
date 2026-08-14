import { expect, test } from "@playwright/test";

const API = `http://127.0.0.1:${7430 + Number(process.env.HARNESS_E2E_PORT_OFFSET ?? 0)}`;

test("copies the exact session id from Session Detail", async ({ context, page, request }) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const repository = await (
    await request.post(`${API}/api/v1/repositories`, {
      data: {
        name: `pw-copy-id-${suffix}`,
        url: `/tmp/pw-copy-id-${suffix}`,
        defaultBranch: "main",
      },
    })
  ).json();
  const command = await (
    await request.post(`${API}/api/v1/commands`, {
      data: { name: `pw-copy-id-${suffix}`, argv: ["echo"], providerId: null },
    })
  ).json();
  const session = await (
    await request.post(`${API}/api/v1/sessions`, {
      data: {
        repositoryId: repository.id,
        prompt: `copy session id ${suffix}`,
        target: { commandId: command.id },
        timeout: 30,
        source: "api",
      },
    })
  ).json();

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/sessions/${session.id}`);
  await expect(page.getByTestId("session-detail-id")).toHaveText(session.id);
  await page.getByTestId("session-detail-copy-id").click();
  await expect(page.getByTestId("session-detail-copy-id")).toHaveText("Copied");
  await expect(page.getByTestId("session-detail-copy-status")).toHaveText("Session ID copied");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(session.id);
});

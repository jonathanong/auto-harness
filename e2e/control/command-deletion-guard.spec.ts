import { expect, test } from "@playwright/test";

const API = `http://127.0.0.1:${7430 + Number(process.env.HARNESS_E2E_PORT_OFFSET ?? 0)}`;

test("reports the precise provider-account scope blocking command deletion", async ({
  page,
  request,
}) => {
  const suffix = `${test.info().parallelIndex}-${Date.now()}`;
  const provider = await (
    await request.post(`${API}/api/v1/providers`, {
      data: { name: `pw-delete-guard-${suffix}` },
    })
  ).json();
  const defaultCommand = await (
    await request.post(`${API}/api/v1/commands`, {
      data: {
        name: `pw-delete-default-${suffix}`,
        argv: ["echo", "default"],
        providerId: provider.id,
      },
    })
  ).json();
  const overrideCommand = await (
    await request.post(`${API}/api/v1/commands`, {
      data: {
        name: `pw-delete-override-${suffix}`,
        argv: ["echo", "override"],
        providerId: provider.id,
      },
    })
  ).json();
  await request.patch(`${API}/api/v1/providers/${provider.id}`, {
    data: { defaultCommandId: defaultCommand.id },
  });
  const account = await (
    await request.post(`${API}/api/v1/provider-accounts`, {
      data: { providerId: provider.id, label: `pw-delete-${suffix}@example.test` },
    })
  ).json();
  const hostId = `pw-delete-host-${suffix}`;
  const repositoryId = `pw-delete-repository-${suffix}`;
  const worktreeId = `pw-delete-worktree-${suffix}`;
  await request.put(`${API}/api/v1/hosts/${hostId}/inventory`, {
    data: {
      repositories: [
        {
          id: repositoryId,
          path: `/tmp/${repositoryId}`,
          defaultBranch: "main",
          worktrees: [
            {
              id: worktreeId,
              name: worktreeId,
              path: `/tmp/${repositoryId}/${worktreeId}`,
              labels: [],
              providerAccountOverrides: {
                [account.id]: { commandId: overrideCommand.id },
              },
            },
          ],
        },
      ],
      providerAccounts: [{ providerAccountId: account.id }],
      commandProfiles: {},
    },
  });

  await page.goto(`/commands/${overrideCommand.id}`);
  await page.getByTestId("delete-command-open").click();
  await page.getByTestId("delete-command-confirm-submit").click();
  const error = page.getByTestId("delete-command-error");
  await expect(error).toHaveRole("alert");
  await expect(error).toContainText(`worktree ${worktreeId} command override on host ${hostId}`);
  await expect(page).toHaveURL(new RegExp(`/commands/${overrideCommand.id}$`));
});

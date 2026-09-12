import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("getHostDurable residual coverage", () => {
  it("reuses a matching worktree page cursor", async () => {
    const record = {
      id: "wt-1",
      name: "wt-1",
      hostId: "host-a",
      repositoryId: "repo-1",
      path: "/wt-1",
      labels: [],
      status: "idle" as const,
      online: true,
    };
    const plane = new ControlPlane({
      storage: {
        listWorktreesPage: async () => ({ items: [record], nextKey: { id: "wt-1" } }),
      } as never,
    });
    const page = await plane.listWorktreesPageDurable({
      limit: 1,
      cursor: null,
      hostId: "host-a",
      repositoryId: "repo-1",
    });
    await expect(
      plane.listWorktreesPageDurable({
        limit: 1,
        cursor: page.nextCursor,
        hostId: "host-a",
        repositoryId: "repo-1",
      }),
    ).resolves.toMatchObject({ items: [{ id: "wt-1" }] });
  });

  it("hydrates inventory without a host lock reader", async () => {
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-4",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
      } as never,
    });
    await expect(plane.getHostDurable("host-4")).resolves.toMatchObject({
      hostId: "host-4",
      online: false,
    });
  });
});

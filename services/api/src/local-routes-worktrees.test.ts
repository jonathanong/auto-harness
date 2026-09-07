import { describe, expect, it, vi } from "vitest";

import { handleWorktreeReadRoutes } from "./local-routes-worktrees.ts";

function routeCtx(
  path: string,
  principal?: { boundHostId?: string; allowedRepositoryIds?: string[] },
) {
  let status = 0;
  let body = "";
  const listWorktreesPageDurable = vi.fn(async () => ({ items: [], nextCursor: "s1.next" }));
  const getWorktreeDurable = vi.fn(async () => ({
    id: "wt-1",
    hostId: "host-a",
    repositoryId: "repo-2",
  }));
  return {
    listWorktreesPageDurable,
    getWorktreeDurable,
    result: () => ({ status, body: body ? JSON.parse(body) : null }),
    ctx: {
      method: "GET",
      url: new URL(`http://x${path}`),
      principal,
      plane: { listWorktreesPageDurable, getWorktreeDurable },
      res: {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(payload?: string) {
          body = payload ?? "";
        },
      },
    },
  };
}

describe("handleWorktreeReadRoutes", () => {
  it("scopes storage pages to a bound host and rejects a mismatched hostId", async () => {
    const bound = routeCtx("/api/v1/worktrees", { boundHostId: "host-a" });
    await expect(handleWorktreeReadRoutes(bound.ctx as never)).resolves.toBe(true);
    expect(bound.listWorktreesPageDurable).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "host-a", repositoryId: null }),
    );

    const mismatch = routeCtx("/api/v1/worktrees?hostId=host-b", { boundHostId: "host-a" });
    await expect(handleWorktreeReadRoutes(mismatch.ctx as never)).resolves.toBe(true);
    expect(mismatch.listWorktreesPageDurable).not.toHaveBeenCalled();
    expect(mismatch.result()).toEqual({ status: 200, body: { items: [], nextCursor: null } });
  });

  it("scopes a single allowed repository and rejects an out-of-scope repositoryId", async () => {
    const scoped = routeCtx("/api/v1/worktrees", { allowedRepositoryIds: ["repo-1"] });
    await expect(handleWorktreeReadRoutes(scoped.ctx as never)).resolves.toBe(true);
    expect(scoped.listWorktreesPageDurable).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "repo-1" }),
    );

    const mismatch = routeCtx("/api/v1/worktrees?repositoryId=repo-2", {
      allowedRepositoryIds: ["repo-1"],
    });
    await expect(handleWorktreeReadRoutes(mismatch.ctx as never)).resolves.toBe(true);
    expect(mismatch.listWorktreesPageDurable).not.toHaveBeenCalled();
    expect(mismatch.result()).toEqual({ status: 200, body: { items: [], nextCursor: null } });
  });

  it("hides a worktree outside the principal repository scope", async () => {
    const scoped = routeCtx("/api/v1/worktrees/wt-1", { allowedRepositoryIds: ["repo-1"] });
    await expect(handleWorktreeReadRoutes(scoped.ctx as never)).resolves.toBe(true);
    expect(scoped.result().status).toBe(404);
  });
});

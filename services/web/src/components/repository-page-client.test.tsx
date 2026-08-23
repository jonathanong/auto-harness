// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, json, mountForm, press } from "./form-test-helpers.tsx";
import { RepositoryPageClient } from "./repository-page-client.tsx";

const repo = (id: string) => ({
  id,
  name: id,
  url: `/tmp/${id}`,
  sessionCount: 0,
  worktreeCount: 0,
  scheduleCount: 0,
});

afterEach(() => vi.unstubAllGlobals());

describe("RepositoryPageClient", () => {
  it("appends cursor pages while preserving the bounded list path", async () => {
    const request = vi.fn().mockResolvedValue(json({ items: [repo("second")], nextCursor: null }));
    vi.stubGlobal("fetch", request);
    const view = mountForm(
      <RepositoryPageClient
        initialItems={[repo("first")]}
        initialNextCursor="next"
        initialPath="/api/v1/repositories?limit=1"
        attachRepositories={[repo("first"), repo("second")]}
        hostIds={[]}
        worktrees={[]}
        canWriteInventory={false}
        canWriteCatalog={false}
      />,
    );
    await act(async () => press(field(view.container, "repositories-load-more")));
    expect(request).toHaveBeenCalledWith(
      "/api/v1/repositories?limit=1&cursor=next",
      expect.anything(),
    );
    expect(field(view.container, "repo-link-second")).toBeTruthy();
    expect(view.container.querySelector('[data-pw="repositories-load-more"]')).toBeNull();
    view.unmount();
  });

  it("keeps loaded rows and exposes a retry when continuation fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ items: [repo("recovered")], nextCursor: null }));
    vi.stubGlobal("fetch", request);
    const view = mountForm(
      <RepositoryPageClient
        initialItems={[repo("first")]}
        initialNextCursor="next"
        initialPath="/api/v1/repositories?limit=1"
        attachRepositories={[repo("first"), repo("recovered")]}
        hostIds={[]}
        worktrees={[]}
        canWriteInventory={false}
        canWriteCatalog={false}
      />,
    );
    await act(async () => press(field(view.container, "repositories-load-more")));
    expect(field(view.container, "repositories-load-more-error").textContent).toContain("503");
    expect(field(view.container, "repo-link-first")).toBeTruthy();
    await act(async () => press(field(view.container, "repositories-load-more-retry")));
    expect(field(view.container, "repo-link-recovered")).toBeTruthy();
    view.unmount();
  });
});

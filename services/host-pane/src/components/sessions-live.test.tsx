// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionListQuery } from "@auto-harness/shared";
import { expect, it, vi } from "vitest";

import { SessionsLive } from "./sessions-live.tsx";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const listState: SessionListQuery = {
  status: "all",
  q: "",
  concurrencyId: "",
  cursor: "",
  limit: 1,
  repositoryId: "repo-1",
  scheduleId: "",
  hostId: "",
  source: "",
  sort: "latest",
};

it("appends the host-scoped next page through the same-origin API", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ items: [{ id: "older", status: "completed" }], nextCursor: null }),
    );
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <SessionsLive
        initialItems={[{ id: "newer", status: "running", repositoryId: "repo-1" }]}
        initialNextCursor="next-host"
        path="/api/v1/sessions?limit=1&repositoryId=repo-1&hostId=local-1"
        listState={listState}
        repositoryNames={{ "repo-1": "Harness" }}
        prioritySortHref="/sessions?sort=priority_desc"
        createdSortHref="/sessions?sort=oldest"
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-pw="sessions-load-more"]')!.click(),
  );
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/sessions?limit=1&repositoryId=repo-1&hostId=local-1&cursor=next-host",
    { credentials: "same-origin" },
  );
  expect(container.querySelector('[data-pw="session-row-newer"]')).toBeTruthy();
  expect(container.querySelector('[data-pw="session-row-older"]')).toBeTruthy();
  expect(container.textContent).toContain("Harness");
  act(() => root.unmount());
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import RepositoriesPage from "./page.tsx";

const originalFetch = globalThis.fetch;
const originalHostId = process.env.HARNESS_HOST_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane repositories route", () => {
  it("renders catalog names and live worktree state from its external API requests", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/inventory")) {
        return Response.json({
          repositories: [
            {
              id: "repo-known",
              path: "/work/known",
              worktrees: [{ id: "live", name: "main", path: "/work/known", labels: ["fast"] }],
            },
            {
              id: "repo-deleted",
              path: "/work/deleted",
              worktrees: [{ id: "offline", name: "next", path: "/work/deleted", labels: [] }],
            },
          ],
        });
      }
      if (url.endsWith("/worktrees")) {
        return Response.json({
          items: [{ id: "live", hostId: "host-a", status: "busy", online: true }],
        });
      }
      return Response.json({ items: [{ id: "repo-known", name: "Known repo" }] });
    });

    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(markup).toContain("Known repo");
    expect(markup).toContain("repo-deleted");
    expect(markup).toContain("busy");
    expect(markup).toContain("Add repository");
  });

  it("renders the empty inventory state when API requests fail", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });

    expect(renderToStaticMarkup(await RepositoriesPage())).toContain(
      "No repositories on this agent yet.",
    );
  });
});

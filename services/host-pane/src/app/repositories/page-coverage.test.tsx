import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setApiTransportForTests } from "../../lib/api.ts";
import RepositoriesPage from "./page.tsx";

const originalHostId = process.env.HARNESS_HOST_ID;

afterEach(() => {
  setApiTransportForTests(undefined);
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane repositories route", () => {
  it("renders catalog names and live worktree state from its external API requests", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    setApiTransportForTests(async (input) => {
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
      if (url.includes("/worktrees?hostId=")) {
        return Response.json({
          items: [{ id: "live", status: "busy", online: true }],
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

  it("follows repository catalog cursors without changing attached inventory", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    const calls: string[] = [];
    setApiTransportForTests(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/inventory")) {
        return Response.json({
          repositories: [
            {
              id: "repo-known",
              path: "/work/known",
              worktrees: [{ id: "attached", name: "main", path: "/work/known", labels: [] }],
            },
          ],
        });
      }
      if (url.includes("/worktrees?hostId=")) return Response.json({ items: [] });
      if (url.includes("cursor=next")) {
        return Response.json({ items: [{ id: "repo-next", name: "Next repo" }] });
      }
      return Response.json({
        items: [{ id: "repo-known", name: "Known repo" }],
        nextCursor: "next",
      });
    });

    const markup = renderToStaticMarkup(await RepositoriesPage());

    expect(calls.some((url) => url.includes("cursor=next"))).toBe(true);
    expect(markup).toContain("Known repo");
    expect(markup).toContain("attached");
  });

  it("renders the empty inventory state when API requests fail", async () => {
    setApiTransportForTests(async () => {
      throw new Error("offline");
    });

    expect(renderToStaticMarkup(await RepositoriesPage())).toContain(
      "No repositories on this agent yet.",
    );
  });
});

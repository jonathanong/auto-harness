import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setApiTransportForTests } from "../../lib/api.ts";
import SessionsPage from "./page.tsx";

const originalHostId = process.env.HARNESS_HOST_ID;

afterEach(() => {
  setApiTransportForTests(undefined);
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane sessions route", () => {
  it("renders live sessions for the configured host", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    setApiTransportForTests(async (input) => {
      const url = String(input);
      if (url.includes("/sessions")) {
        return Response.json({
          items: [{ id: "s-1", status: "queued", repositoryId: "r-1", prompt: "hi" }],
          nextCursor: null,
        });
      }
      return Response.json({ items: [{ id: "r-1", name: "Repo" }] });
    });

    const markup = renderToStaticMarkup(
      await SessionsPage({ searchParams: Promise.resolve({ status: "queued" }) }),
    );
    expect(markup).toContain('data-pw="page-sessions"');
    expect(markup).toContain("host-a");
  });

  it("renders the error state when the sessions request fails", async () => {
    setApiTransportForTests(async () => {
      throw new Error("offline");
    });
    const markup = renderToStaticMarkup(await SessionsPage({ searchParams: Promise.resolve({}) }));
    expect(markup).toContain("offline");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setApiTransportForTests } from "../lib/api.ts";
import RootLayout from "./layout.tsx";
import HostHomePage from "./page.tsx";

const originalHostId = process.env.HARNESS_HOST_ID;
const originalSentry = process.env.HARNESS_HOST_PANE_SENTRY_DSN_CLIENT;

afterEach(() => {
  setApiTransportForTests(undefined);
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
  if (originalSentry === undefined) delete process.env.HARNESS_HOST_PANE_SENTRY_DSN_CLIENT;
  else process.env.HARNESS_HOST_PANE_SENTRY_DSN_CLIENT = originalSentry;
});

describe("host-pane root routes", () => {
  it("renders the shell with the matching host's live status", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    process.env.HARNESS_HOST_PANE_SENTRY_DSN_CLIENT = "https://abc123@o1.ingest.sentry.io/450";
    setApiTransportForTests(async () =>
      Response.json({
        hostId: "host-a",
        online: true,
      }),
    );

    const markup = renderToStaticMarkup(await RootLayout({ children: <main>Child content</main> }));

    expect(markup).toContain("Host UI for host-a");
    expect(markup).toContain('data-pw="host-shell-online"');
    expect(markup).toContain("Child content");
  });

  it("renders without a status badge when the host request is empty or unavailable", async () => {
    process.env.HARNESS_HOST_ID = "host-b";
    setApiTransportForTests(async () => Response.json({}));
    const emptyMarkup = renderToStaticMarkup(await RootLayout({ children: "Empty list" }));

    setApiTransportForTests(async () => {
      throw new Error("control plane unavailable");
    });
    const errorMarkup = renderToStaticMarkup(await RootLayout({ children: "Unavailable" }));

    expect(emptyMarkup).not.toContain("host-shell-online");
    expect(errorMarkup).not.toContain("host-shell-online");
    expect(errorMarkup).toContain("host-shell");
    expect(errorMarkup).not.toContain("This is the debug host pane");

    setApiTransportForTests(async () => new Response("nope", { status: 500 }));
    const serverErrorMarkup = renderToStaticMarkup(await RootLayout({ children: "Server error" }));
    expect(serverErrorMarkup).toContain("host-shell");
    expect(serverErrorMarkup).not.toContain("This is the debug host pane");
  });

  it("shows a readable 401 instead of a half-empty shell", async () => {
    setApiTransportForTests(async () => new Response("authentication required", { status: 401 }));
    const markup = renderToStaticMarkup(await RootLayout({ children: <main>Child content</main> }));

    expect(markup).toContain("This is the debug host pane");
    expect(markup).toMatch(/debug/i);
    expect(markup).toMatch(/control plane/i);
    expect(markup).not.toContain("Child content");
    expect(markup).not.toContain("host-shell");
  });

  it("redirects the host-pane home route to sessions", () => {
    expect(HostHomePage).toThrow(/NEXT_REDIRECT/);
  });
});

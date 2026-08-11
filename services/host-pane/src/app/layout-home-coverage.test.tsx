import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import RootLayout from "./layout.tsx";
import HostHomePage from "./page.tsx";

const originalFetch = globalThis.fetch;
const originalHostId = process.env.HARNESS_HOST_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane root routes", () => {
  it("renders the shell with the matching host's live status", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    vi.stubGlobal("fetch", async () =>
      Response.json({
        items: [
          { hostId: "other", online: false },
          { hostId: "host-a", online: true },
        ],
      }),
    );

    const markup = renderToStaticMarkup(await RootLayout({ children: <main>Child content</main> }));

    expect(markup).toContain("Host UI for host-a");
    expect(markup).toContain('data-pw="host-shell-online"');
    expect(markup).toContain("Child content");
  });

  it("renders without a status badge when the host request is empty or unavailable", async () => {
    process.env.HARNESS_HOST_ID = "host-b";
    vi.stubGlobal("fetch", async () => Response.json({}));
    const emptyMarkup = renderToStaticMarkup(await RootLayout({ children: "Empty list" }));

    vi.stubGlobal("fetch", async () => {
      throw new Error("control plane unavailable");
    });
    const errorMarkup = renderToStaticMarkup(await RootLayout({ children: "Unavailable" }));

    expect(emptyMarkup).not.toContain("host-shell-online");
    expect(errorMarkup).not.toContain("host-shell-online");
  });

  it("redirects the host-pane home route to sessions", () => {
    expect(HostHomePage).toThrow(/NEXT_REDIRECT/);
  });
});

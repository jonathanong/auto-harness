import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@auto-harness/ui";

import SettingsPage from "./page.tsx";

const originalFetch = globalThis.fetch;
const originalHostId = process.env.HARNESS_HOST_ID;
const router: AppRouterInstance = {
  back() {},
  forward() {},
  prefetch() {},
  push() {},
  refresh() {},
  replace() {},
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane settings route", () => {
  it("renders provider-account names and a host inventory with its optional log level", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/inventory")) {
        return Response.json({
          repositories: [],
          providerAccounts: [{ providerAccountId: "account-a" }],
          commandProfiles: { default: ["codex"] },
          logLevel: "debug",
        });
      }
      if (url.endsWith("/providers"))
        return Response.json({ items: [{ id: "provider-a", name: "Provider A" }] });
      if (url.endsWith("/provider-accounts"))
        return Response.json({
          items: [{ id: "account-a", providerId: "provider-a", label: "Account A" }],
        });
      return Response.json({ items: [{ id: "command-a", name: "Command A", argv: ["codex"] }] });
    });

    const markup = render(await SettingsPage());

    expect(markup).toContain("Provider accounts");
    expect(markup).toContain("Provider A — Account A");
    expect(markup).toContain("&quot;logLevel&quot;: &quot;debug&quot;");
  });

  it("keeps raw inventory settings usable when the catalog requests fail", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (String(input).endsWith("/inventory")) return Response.json({});
      throw new Error("catalog unavailable");
    });

    const markup = render(await SettingsPage());

    expect(markup).toContain("Advanced: raw host inventory JSON");
    expect(markup).toContain("&quot;repositories&quot;: []");
  });

  it("uses empty catalog collections when successful responses omit their items", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));

    expect(render(await SettingsPage())).toContain("No provider accounts attached to this host.");
  });
});

function render(page: React.ReactNode): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AppRouterContext.Provider value={router}>{page}</AppRouterContext.Provider>
    </TooltipProvider>,
  );
}

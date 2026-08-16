import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@auto-harness/ui";

import { setApiTransportForTests } from "../../lib/api.ts";
import SettingsPage from "./page.tsx";

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
  setApiTransportForTests(undefined);
  if (originalHostId === undefined) delete process.env.HARNESS_HOST_ID;
  else process.env.HARNESS_HOST_ID = originalHostId;
});

describe("host-pane settings route", () => {
  it("renders provider-account names from the host inventory", async () => {
    process.env.HARNESS_HOST_ID = "host-a";
    setApiTransportForTests(async (input) => {
      const url = String(input);
      if (url.endsWith("/inventory")) {
        return Response.json({
          repositories: [],
          providerAccounts: [{ providerAccountId: "account-a" }],
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
  });

  it("keeps raw inventory settings usable when the catalog requests fail", async () => {
    setApiTransportForTests(async (input) => {
      if (String(input).endsWith("/inventory")) return Response.json({});
      throw new Error("catalog unavailable");
    });

    const markup = render(await SettingsPage());

    expect(markup).toContain("Advanced: raw host inventory JSON");
    expect(markup).toContain("&quot;repositories&quot;: []");
  });

  it("uses empty catalog collections when successful responses omit their items", async () => {
    setApiTransportForTests(async () => Response.json({}));

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

import React from "react";
import { describe, expect, it } from "vitest";

import { renderPage } from "../app/route-test-helpers.tsx";
import { ProviderAccountUnattachedWarning } from "./provider-account-unattached-warning.tsx";

describe("ProviderAccountUnattachedWarning", () => {
  it("renders nothing when every account is attached", async () => {
    const html = await renderPage(<ProviderAccountUnattachedWarning labels={[]} />);
    expect(html).toBe("");
  });

  it("names one unattached account and several unattached accounts", async () => {
    const one = await renderPage(<ProviderAccountUnattachedWarning labels={["work"]} />);
    expect(one).toContain('data-pw="provider-account-unattached-warning"');
    expect(one).toContain("work is not attached to any host");
    const many = await renderPage(
      <ProviderAccountUnattachedWarning labels={["work", "personal"]} />,
    );
    expect(many).toContain("work, personal are not attached to any host");
  });
});

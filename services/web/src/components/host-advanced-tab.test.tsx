import { describe, expect, it } from "vitest";

import { renderPage } from "../app/route-test-helpers.tsx";
import { HostAdvancedTab } from "./host-advanced-tab.tsx";

describe("HostAdvancedTab", () => {
  it("shows executable configuration controls without the inventory editor", async () => {
    const html = await renderPage(
      <HostAdvancedTab
        hostId="host-1"
        initialJson='{"repositories":[]}'
        initialVersion={1}
        setupScript="echo setup"
        allowedRoots={["/repo"]}
        requiredEnvironment={["TOKEN"]}
        canWriteInventory={false}
        canWriteExecConfig
      />,
    );
    expect(html).toContain("echo setup");
    expect(html).not.toContain('data-pw="form-host-config-json"');
  });
});

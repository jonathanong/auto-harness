import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

describe("control-plane UI terminology", () => {
  it("does not expose retired command-profile terminology", () => {
    const dashboard = source("./app/page.tsx");
    const navigation = source("./components/control-shell.tsx");
    const hosts = source("./app/hosts/page.tsx");

    expect(dashboard).toContain("Provider or Command target");
    expect(navigation).toContain("Provider or Command target");
    expect(hosts).toContain("configure Provider accounts");
    expect([dashboard, navigation, hosts].join("\n")).not.toMatch(/command profiles?/i);
  });
});

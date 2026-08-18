import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../.no-mistakes.yml", import.meta.url), "utf8");

describe("no-mistakes rule set", () => {
  it("keeps the first-wave rules and a single multi-app config", () => {
    expect(config).not.toMatch(/^\s*# No `rules:` here/m);
    expect(config).toContain("apps:");
    expect(config).toContain("project: control-web");
    expect(config).toContain("project: host-pane");

    for (const rule of [
      "playwright-unique-test-ids",
      "playwright-coverage",
      "playwright-prefer-test-id-locators",
      "lockfile-allowlist",
      "package-json-workspace-coverage",
      "package-json-registry-only",
      "agents-md-max-size",
      "no-empty-or-comments-only-files",
      "file-extension-policy",
      "workspace-package-cycles",
      "markdown-mermaid-validation",
      "nextjs-no-api-routes",
      "nextjs-no-caching",
      "banned-paths",
      "integration-test-no-mocks",
    ]) {
      expect(config).toContain(`rule: ${rule}`);
    }
  });
});

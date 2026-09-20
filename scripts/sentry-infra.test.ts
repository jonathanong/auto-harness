import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("independent Sentry infrastructure", () => {
  it("owns exactly the four Auto Harness projects with protected lifecycle", () => {
    const main = source("opentofu/sentry/main.tf");
    const expected = [
      "auto-harness-control-plane-lambda",
      "auto-harness-control-plane-web",
      "auto-harness-host-plane-backend",
      "auto-harness-host-plane-web",
    ];
    for (const project of expected) expect(main).toContain(`name     = "${project}"`);
    expect(main.match(/name     = "auto-harness-/g)).toHaveLength(expected.length);
    expect(main).not.toContain("vouchington-backend");
    expect(main).not.toContain("agent-blackboard");
    expect(main).toContain("default_key   = false");
    expect(main).toContain("default_rules = false");
    expect(main.match(/prevent_destroy = true/g)).toHaveLength(2);
  });

  it("pins the provider and exposes only public DSNs", () => {
    expect(source("opentofu/sentry/versions.tf")).toContain('version = "= 0.15.7"');
    const outputs = source("opentofu/sentry/outputs.tf");
    expect(outputs).toContain('dsn["public"]');
    expect(outputs).toContain("nonsensitive(");
    expect(outputs).not.toContain("dsn_secret");
  });

  it("uploads control-web maps only inside the exact deploy image build", () => {
    const dockerfile = source("services/web/Dockerfile.aws");
    const cdk = source("services/cdk/src/cli.ts");
    const deploy = source("scripts/deploy-aws.sh");
    expect(dockerfile).toContain("--mount=type=secret,id=SENTRY_AUTH_TOKEN");
    expect(dockerfile).not.toContain("ARG SENTRY_AUTH_TOKEN");
    expect(dockerfile).not.toContain("ENV SENTRY_AUTH_TOKEN");
    expect(cdk).toContain('SENTRY_AUTH_TOKEN: "env=HARNESS_SENTRY_UPLOAD_TOKEN"');
    expect(deploy).toContain('export HARNESS_SENTRY_RELEASE="$synced_head"');
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
const labelerConfig = readFileSync(new URL("../.github/labeler.yml", import.meta.url), "utf8");
const labelerWorkflow = readFileSync(
  new URL("../.github/workflows/labeler.yml", import.meta.url),
  "utf8",
);
const actionlintWorkflow = readFileSync(
  new URL("../.github/workflows/actionlint.yml", import.meta.url),
  "utf8",
);
const actionlintConfig = readFileSync(
  new URL("../.github/actionlint.yaml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

const PINNED_ACTION = /uses: ([^\s@]+)@([0-9a-f]{40}) # /g;

function ecosystemBlock(name: string): string {
  const marker = `package-ecosystem: ${name}\n`;
  const start = dependabot.indexOf(marker);
  if (start === -1) throw new Error(`Missing Dependabot ecosystem: ${name}`);
  const next = dependabot.indexOf("package-ecosystem:", start + marker.length);
  return dependabot.slice(start, next === -1 ? undefined : next);
}

describe("Dependabot version updates", () => {
  it("covers the lockfile, Actions, web image, and Compose ecosystems", () => {
    expect(dependabot).toContain("version: 2\n");
    expect(
      [...dependabot.matchAll(/package-ecosystem: ([^\n]+)/g)].map((match) => match[1]),
    ).toEqual(["npm", "github-actions", "docker", "docker-compose"]);
    expect(ecosystemBlock("npm")).toContain('directory: "/"');
    expect(ecosystemBlock("github-actions")).toContain('directory: "/"');
    expect(ecosystemBlock("docker")).toContain("directory: /services/web");
    expect(ecosystemBlock("docker-compose")).toContain('directory: "/"');
  });

  it("groups routine version bumps and leaves security updates ungrouped", () => {
    for (const name of ["npm", "github-actions", "docker", "docker-compose"]) {
      const block = ecosystemBlock(name);
      expect(block).toContain("interval: weekly");
      expect(block).toContain("day: monday");
      expect(block).toContain("- dependencies");
      expect(block).toContain("prefix: chore");
      expect(block).toContain("include: scope");
      expect(block).toContain("applies-to: version-updates");
    }
    expect(ecosystemBlock("npm")).toContain("open-pull-requests-limit: 10");
    expect(ecosystemBlock("npm")).toContain("dependency-type: production");
    expect(ecosystemBlock("npm")).toContain("dependency-type: development");
  });

  it("ignores node-pty version bumps while leaving security updates enabled", () => {
    expect(workspace).toContain("node-pty@1.1.0:");
    const npm = ecosystemBlock("npm");
    expect(npm).toContain("dependency-name: node-pty");
    expect(npm).toContain("- version-update:semver-major");
    expect(npm).toContain("- version-update:semver-minor");
    expect(npm).toContain("- version-update:semver-patch");
  });
});

describe("pull request labeler", () => {
  it("maps each workspace package and shared surface to a stable label", () => {
    expect(labelerConfig).toContain(
      "area/api:\n  - changed-files:\n      - any-glob-to-any-file: services/api/**",
    );
    expect(labelerConfig).toContain("any-glob-to-any-file: services/web/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: services/host-pane/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: services/host-daemon/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: services/cdk/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: modules/shared/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: modules/ui/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: modules/client/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: e2e/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: integration/**");
    expect(labelerConfig).toContain("any-glob-to-any-file: scripts/**");
    expect(labelerConfig).toContain("- .github/**");
    expect(labelerConfig).toContain("- actions/**");
    expect(labelerConfig).toContain("- docker-compose.yml");
    expect(labelerConfig).toContain("documentation:");
    expect(labelerConfig).toContain('- "**/*.md"');
  });

  it("labels same-repo pull requests with a SHA-pinned action", () => {
    expect(labelerWorkflow).toContain("pull_request:\n    branches: [main]");
    expect(labelerWorkflow).not.toContain("pull_request_target");
    expect(labelerWorkflow).toContain("pull-requests: write");
    expect(labelerWorkflow).toContain("issues: write");
    expect(labelerWorkflow).toContain(
      "uses: actions/labeler@bf12e9b00b37c5c0ca2b87b79b2daf7891dbda13 # v7.0.0",
    );
    expect(labelerWorkflow).toContain("sync-labels: true");
    expect(labelerWorkflow).not.toContain("uses: actions/checkout@");
  });
});

describe("actionlint", () => {
  it("downloads a checksummed release and lints workflows on CI events", () => {
    expect(actionlintWorkflow).toContain("branches: [main]");
    expect(actionlintWorkflow).toContain(
      "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    );
    expect(actionlintWorkflow).toContain('ACTIONLINT_VERSION: "1.7.12"');
    expect(actionlintWorkflow).toContain(
      "ACTIONLINT_SHA256: 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    );
    expect(actionlintWorkflow).toContain("sha256sum --check --strict");
    expect(actionlintWorkflow).toContain("./actionlint -color");
    expect(actionlintConfig).toContain("- VITEST_SHARDS");
    expect(actionlintConfig).toContain("- PLAYWRIGHT_E2E_SHARDS");
  });
});

describe("GitHub Actions pin and image alignment", () => {
  it("pins every workflow action to a 40-character SHA", () => {
    const files = readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(new URL(name, workflowsDir), "utf8");
      const uses = [...source.matchAll(/^[- ]+uses: (.+)$/gm)].map((match) => match[1]);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const spec of uses) {
        expect(spec, `${name}: ${spec}`).toMatch(/^[^\s@]+@[0-9a-f]{40} # /);
      }
      expect([...source.matchAll(PINNED_ACTION)].length, name).toBe(uses.length);
    }
  });

  it("keeps DynamoDB Local tags aligned between CI and Compose", () => {
    const image = "amazon/dynamodb-local:3.3.1";
    expect(ciWorkflow).toContain(`image: ${image}`);
    expect(compose.match(new RegExp(`image: ${image}`, "g"))).toHaveLength(2);
  });
});

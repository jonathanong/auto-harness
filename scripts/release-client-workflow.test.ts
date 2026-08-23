import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release-client.yml", import.meta.url),
  "utf8",
);

const publishJob = workflow.slice(workflow.indexOf("  publish:\n"));

describe("client release workflow contract", () => {
  it("only runs for a client version tag and serializes releases without cancellation", () => {
    expect(workflow).toContain('tags: ["client-v*"]');
    expect(workflow).toContain("group: release-client-${{ github.ref }}");
    expect(workflow).not.toContain("group: release-client\n");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
  });

  it("publishes through the protected npm environment with a bounded job", () => {
    expect(publishJob).toContain("timeout-minutes: 20");
    expect(publishJob).toContain("environment: npm-publish");
  });

  it("checks out and verifies the pushed tag commit with full history", () => {
    expect(publishJob).toContain("ref: ${{ github.ref }}");
    expect(publishJob).toContain("fetch-depth: 0");
    expect(publishJob).toContain("fetch-tags: true");
    expect(publishJob).toContain("persist-credentials: false");
    expect(publishJob).toContain("EVENT_SHA: ${{ github.sha }}");
    expect(publishJob).toContain("refs/tags/${RELEASE_TAG}^{commit}");
    expect(publishJob).toContain('"${EVENT_SHA}^{commit}"');
    expect(publishJob).toContain('checked_out_commit="$(git rev-parse HEAD)"');
    expect(publishJob).toContain('test "$tag_commit" = "$event_commit"');
    expect(publishJob).toContain('test "$tag_commit" = "$checked_out_commit"');
  });

  it("requires the peeled tag commit to already be in origin/main", () => {
    expect(publishJob).toContain("git fetch --no-tags origin main");
    expect(publishJob).toContain('main_commit="$(git rev-parse FETCH_HEAD)"');
    expect(publishJob).toContain('git merge-base --is-ancestor "$tag_commit" "$main_commit"');
  });

  it("validates the exact package identity and version before checks and publish", () => {
    expect(publishJob).toContain(
      'manifest_name="$(node -p "require(\'./modules/client/package.json\').name")"',
    );
    expect(publishJob).toContain(
      'manifest_version="$(node -p "require(\'./modules/client/package.json\').version")"',
    );
    expect(publishJob).toContain('test "$manifest_name" = "auto-harness-client"');
    expect(publishJob).toContain('test "$RELEASE_TAG" = "client-v${manifest_version}"');
    expect(publishJob).toContain(
      "run: pnpm exec tsc --noEmit --project modules/client/tsconfig.json",
    );
    expect(publishJob).toContain("run: pnpm --filter auto-harness-client test");
    expect(publishJob).toContain("run: pnpm --dir modules/client pack --dry-run");
    expect(publishJob).toContain("run: npm publish --access public");

    const manifestCheck = publishJob.indexOf("name: Validate release manifest");
    const tagCheck = publishJob.indexOf("name: Verify release tag and ancestry");
    const pnpmSetup = publishJob.indexOf("uses: pnpm/action-setup@");
    const nodeSetup = publishJob.indexOf("uses: actions/setup-node@");
    const install = publishJob.indexOf("run: pnpm install --frozen-lockfile --ignore-scripts");
    const typecheck = publishJob.indexOf(
      "run: pnpm exec tsc --noEmit --project modules/client/tsconfig.json",
    );
    const tests = publishJob.indexOf("run: pnpm --filter auto-harness-client test");
    const pack = publishJob.indexOf("run: pnpm --dir modules/client pack --dry-run");
    const publish = publishJob.indexOf("run: npm publish --access public");
    expect(tagCheck).toBeGreaterThanOrEqual(0);
    expect(manifestCheck).toBeGreaterThanOrEqual(0);
    expect(tagCheck).toBeLessThan(manifestCheck);
    expect(tagCheck).toBeLessThan(pnpmSetup);
    expect(tagCheck).toBeLessThan(nodeSetup);
    expect(tagCheck).toBeLessThan(install);
    expect(manifestCheck).toBeLessThan(pnpmSetup);
    expect(manifestCheck).toBeLessThan(nodeSetup);
    expect(manifestCheck).toBeLessThan(install);
    expect(manifestCheck).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(tests);
    expect(tests).toBeLessThan(pack);
    expect(pack).toBeLessThan(publish);
  });
});

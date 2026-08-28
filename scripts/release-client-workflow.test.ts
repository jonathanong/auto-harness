import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release-client.yml", import.meta.url),
  "utf8",
);

const publishJob = workflow.slice(workflow.indexOf("  publish:\n"));

describe("client release workflow contract", () => {
  it("is a manually selected main-only release", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("release_type:");
    expect(workflow).toContain("required: true");
    expect(workflow).toContain("type: choice");
    expect(workflow).toContain("- patch");
    expect(workflow).toContain("- minor");
    expect(workflow).toContain("- major");
    expect(workflow).not.toContain('tags: ["client-v*"]');
    expect(workflow).not.toContain("concurrency:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("id-token: write");
    expect(publishJob).toContain("github.ref == 'refs/heads/main'");
    expect(publishJob).toContain(
      "github.workflow_ref == format('{0}/.github/workflows/release-client.yml@refs/heads/main', github.repository)",
    );
  });

  it("uses the protected environment and release token only for release writes", () => {
    expect(publishJob).toContain("timeout-minutes: 20");
    expect(publishJob).toContain("environment: npm-publish");
    expect(publishJob).toContain("ref: main");
    expect(publishJob).toContain("RELEASE_TOKEN: ${{ secrets.RELEASE_TOKEN }}");
    expect(workflow.match(/\$\{\{ secrets\.RELEASE_TOKEN \}\}/g)).toEqual([
      "${{ secrets.RELEASE_TOKEN }}",
      "${{ secrets.RELEASE_TOKEN }}",
    ]);
    expect(publishJob).toContain("fetch-depth: 0");
    expect(publishJob).toContain("fetch-tags: true");
    expect(publishJob).toContain("persist-credentials: false");
    expect(publishJob).toContain("git checkout --detach origin/main");
    expect(publishJob).not.toContain("github.sha");
    expect(publishJob).not.toContain("ref: ${{ github.ref }}");
    expect(publishJob).not.toContain("EVENT_SHA:");
    expect(publishJob).not.toContain("registry-url:");
    expect(publishJob).toContain('test -z "${NPM_TOKEN:-}"');
    expect(publishJob).toContain('test -z "${NODE_AUTH_TOKEN:-}"');
  });

  it("resolves publish and release retries from an exact same-run tag", () => {
    expect(publishJob).toContain("RUN_ATTEMPT: ${{ github.run_attempt }}");
    expect(publishJob).toContain("RUN_ID: ${{ github.run_id }}");
    expect(publishJob).toContain("'' | *[!0-9]*) echo \"invalid GitHub run attempt");
    expect(publishJob).toContain("if (( RUN_ATTEMPT < 1 )); then");
    expect(publishJob).toContain('release_tag="client-v${manifest_version}"');
    expect(publishJob).toContain('"refs/tags/${release_tag}^{commit}"');
    expect(publishJob).toContain(
      'if test "$tag_commit" != "$head_commit" && ! git merge-base --is-ancestor "$tag_commit" "$head_commit"; then',
    );
    expect(publishJob).not.toContain('release_mode="already-published"');
    expect(publishJob).toContain('release_mode="retry-publish"');
    expect(publishJob).toContain('release_mode="release-only"');
    expect(publishJob).toContain("run_release_tags=()");
    expect(publishJob).toContain("Release client v${candidate_version} from GitHub Actions run");
    expect(publishJob).toContain('release_tag="${run_release_tags[0]}"');
    expect(publishJob).toContain('manifest_version="${release_tag#client-v}"');
    expect(publishJob).toContain("multiple release tags belong to this workflow run");
    expect(publishJob).toContain("workflow run owns an invalid release tag");
    expect(publishJob).toContain('test "$tag_subject" != "$expected_tag_subject"');
    expect(publishJob.match(/unpublished release belongs to another run/g)).toHaveLength(1);
    expect(publishJob).toContain("Release client v${manifest_version} from GitHub Actions run");
    expect(publishJob.match(/if \(\( RUN_ATTEMPT > 1 \)\); then/g)).toHaveLength(2);
    expect(publishJob.match(/rerun is already published or was superseded/g)).toHaveLength(1);
    expect(publishJob).toContain('git merge-base --is-ancestor "$tag_commit" "$head_commit"');
    expect(publishJob).toContain('git checkout --detach "$release_tag"');
    expect(publishJob).toContain('test "$(git rev-parse HEAD)" = "$tag_commit"');
    expect(publishJob).toContain(
      "git describe --tags --match 'client-v*' --abbrev=0 \"${tag_commit}^\"",
    );
    expect(publishJob).toContain("release tag is not an ancestor of current main");
    expect(publishJob).toContain("start_new_release");
    expect(publishJob).toContain(
      "fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)",
    );
    expect(publishJob).not.toContain("pnpm --dir modules/client version");
    expect(publishJob).not.toContain("pnpm --dir modules/client pkg set");
    expect(publishJob).not.toContain("npm --prefix modules/client version");
    expect(publishJob).toContain(
      'npm view "$manifest_name@$1" version --json --registry=https://registry.npmjs.org',
    );
    expect(publishJob).toContain("npm version already exists without a matching release tag");
  });

  it("validates, atomically records, OIDC-publishes, then creates a GitHub Release", () => {
    const resolve = publishJob.indexOf("name: Resolve new or interrupted release");
    const install = publishJob.indexOf("name: Install release snapshot");
    const validate = publishJob.indexOf("name: Validate package");
    const commit = publishJob.indexOf("name: Commit and tag release");
    const push = publishJob.indexOf("name: Push release commit and tag");
    const publish = publishJob.indexOf("name: Publish with npm OIDC provenance");
    const release = publishJob.indexOf("name: Publish GitHub Release");

    expect(publishJob).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(publishJob).toContain("pnpm exec tsc --noEmit --project modules/client/tsconfig.json");
    expect(publishJob).toContain("pnpm --filter auto-harness-client test");
    expect(publishJob).toContain("pnpm --dir modules/client pack --dry-run");
    expect(publishJob).toContain('test "$(git rev-parse origin/main)" = "$RELEASE_BASE_SHA"');
    expect(publishJob).toContain('test "$(git diff --name-only)" = "modules/client/package.json"');
    expect(publishJob).toContain('git commit -m "release(client): v${RELEASE_VERSION}"');
    expect(publishJob).toContain('git tag --annotate "$RELEASE_TAG"');
    expect(publishJob).toContain("Release client v${RELEASE_VERSION} from GitHub Actions run");
    expect(publishJob).toContain(
      'push --atomic origin HEAD:refs/heads/main "refs/tags/${RELEASE_TAG}"',
    );
    expect(publishJob).toContain("AUTHORIZATION: basic ${auth_header}");
    expect(publishJob).toContain(
      "npm publish --provenance --access public --registry=https://registry.npmjs.org",
    );
    expect(publishJob).toContain("if: env.RELEASE_MODE != 'release-only'");
    expect(publishJob).not.toContain("npm publish --access public\n");
    expect(publishJob).toContain('gh release create "${release_args[@]}"');
    expect(publishJob).toContain("--verify-tag");
    expect(publishJob).toContain("--generate-notes");
    expect(publishJob).toContain('--notes-start-tag "$RELEASE_NOTES_START_TAG"');
    expect(publishJob).toContain('--title "auto-harness-client v${RELEASE_VERSION}"');
    expect(publishJob).toContain('gh release view "$RELEASE_TAG"');
    expect(publishJob).toContain("GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}");
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(resolve);
    expect(validate).toBeGreaterThan(install);
    expect(commit).toBeGreaterThan(validate);
    expect(push).toBeGreaterThan(commit);
    expect(publish).toBeGreaterThan(push);
    expect(release).toBeGreaterThan(publish);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/release-actions.yml", import.meta.url),
  "utf8",
);

const releaseJob = workflow.slice(workflow.indexOf("  release:\n"));

describe("actions release workflow contract", () => {
  it("is a manually selected main-only release", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("release_type:");
    expect(workflow).toContain("type: choice");
    for (const choice of ["- patch", "- minor", "- major"]) expect(workflow).toContain(choice);
    expect(workflow).not.toMatch(/^\s+tags:/m);
    expect(workflow).toContain("contents: read");
    expect(workflow).not.toContain("id-token: write");
    expect(releaseJob).toContain("github.ref == 'refs/heads/main'");
    expect(releaseJob).toContain(
      "github.workflow_ref == format('{0}/.github/workflows/release-actions.yml@refs/heads/main', github.repository)",
    );
    expect(releaseJob).toContain("persist-credentials: false");
    expect(releaseJob).toContain("git checkout --detach origin/main");
    expect(releaseJob).not.toContain("github.sha");
  });

  it("tags the fetched main head with the next plain vX.Y.Z and never a client tag", () => {
    expect(releaseJob).toContain(
      "grep -E '^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'",
    );
    expect(releaseJob).toContain(
      'previous_tag="$(semver_tags --merged "$head_commit" | tail -n 1)"',
    );
    expect(releaseJob).toContain('release_tag="v${major}.${minor}.${patch}"');
    expect(releaseJob).toContain("already has an actions release tag; nothing new to release");
    expect(releaseJob).toContain("release tag already exists");
    expect(releaseJob).not.toContain("client-v");
    expect(releaseJob).not.toContain("package.json");
    expect(releaseJob).toContain('git tag --annotate "$RELEASE_TAG" "$RELEASE_COMMIT"');
    expect(releaseJob).toContain('push origin "refs/tags/${RELEASE_TAG}"');
    expect(releaseJob).not.toContain("HEAD:refs/heads/main");
  });

  it("finishes a rerun from the tag its own run pushed", () => {
    expect(releaseJob).toContain("RUN_ID: ${{ github.run_id }}");
    expect(releaseJob).toContain(
      'if test "$subject" = "Release actions ${candidate_tag} from GitHub Actions run ${RUN_ID}"; then',
    );
    expect(releaseJob).toContain("multiple release tags belong to this workflow run");
    expect(releaseJob).toContain('echo "RELEASE_MODE=release-only"');
    expect(releaseJob).toContain("if: env.RELEASE_MODE == 'new'");
    expect(releaseJob).toContain(
      '--message "Release actions ${RELEASE_TAG} from GitHub Actions run ${RELEASE_RUN_ID}"',
    );
  });

  it("uses the release token only for the tag push and the GitHub Release", () => {
    expect(workflow.match(/\$\{\{ secrets\.RELEASE_TOKEN \}\}/g)).toHaveLength(2);
    expect(releaseJob).toContain('gh release view "$RELEASE_TAG"');
    expect(releaseJob).toContain("--verify-tag");
    expect(releaseJob).toContain("--latest=false");
    expect(releaseJob).toContain('--notes-start-tag "$PREVIOUS_TAG"');
  });
});

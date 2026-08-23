import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const staticAnalysis = workflow.slice(
  workflow.indexOf("  static-code-analysis:\n"),
  workflow.indexOf("  test-shard-config:\n"),
);

describe("client version policy", () => {
  it("rejects client manifest version changes in pull requests", () => {
    expect(staticAnalysis).toContain("fetch-depth: 0");
    expect(staticAnalysis).toContain("name: Reject pull request client version bumps");
    expect(staticAnalysis).toContain("if: github.event_name == 'pull_request'");
    expect(staticAnalysis).toContain("BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(staticAnalysis).toContain(
      'git show "${BASE_SHA}:modules/client/package.json" | jq --exit-status --raw-output .version',
    );
    expect(staticAnalysis).toContain(
      "Client versions are created only by the Release client workflow",
    );
  });
});

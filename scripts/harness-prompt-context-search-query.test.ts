import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run, stubGh, useFixtures } from "./harness-prompt-context-test-helpers.ts";

const { make } = useFixtures();

const stubEmptyRelatedLists = (fx: ReturnType<typeof make>) =>
  stubGh(
    fx.bin,
    fx.callLog,
    `case "$1 $2" in
  "pr list") printf '%s' '[]' ;;
  "issue list") printf '%s' '[]' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac`,
  );

describe("harness-prompt-context run script search query construction", () => {
  it("quotes newline-separated related-extra-labels so spaces survive in the search query", () => {
    const fx = make();
    stubEmptyRelatedLists(fx);

    const result = run(fx, {
      RELATED_TITLE_KEY: "flaky test",
      RELATED_EXTRA_LABELS: "automation\nneeds review",
    });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('label:"automation"');
    expect(calls).toContain('label:"needs review"');
  });

  it("escapes embedded double quotes in related-title-key before building the search query", () => {
    const fx = make();
    stubEmptyRelatedLists(fx);

    const result = run(fx, {
      RELATED_TITLE_KEY: 'fix "use client" warning',
      RELATED_EXTRA_LABELS: "",
    });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('fix \\"use client\\" warning');
  });

  it("escapes embedded double quotes in related-extra-labels before building the search query", () => {
    const fx = make();
    stubEmptyRelatedLists(fx);

    const result = run(fx, {
      RELATED_TITLE_KEY: "flaky test",
      RELATED_EXTRA_LABELS: 'needs "review"',
    });
    const calls = readFileSync(fx.callLog, "utf8");

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('needs \\"review\\"');
  });
});

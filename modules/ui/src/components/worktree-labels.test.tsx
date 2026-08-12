import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorktreeLabels } from "./worktree-labels.tsx";

describe("WorktreeLabels", () => {
  it("preserves exact values while deduplicating and sorting scheduler chips", () => {
    const html = renderToStaticMarkup(
      <WorktreeLabels worktreeId="wt/1" labels={[" linux ", "gpu", "linux", "gpu", ""]} />,
    );
    expect(html).toContain('data-pw="worktree-labels-wt/1"');
    expect(html).toContain("Scheduler label: gpu");
    expect(html).toContain("Scheduler label: linux");
    expect(html).toContain('class="whitespace-pre"> linux </span>');
    expect(html).toContain('class="whitespace-pre"></span>');
    expect(html.match(/title="Scheduler label:/g)).toHaveLength(4);
    expect(html.indexOf(">gpu</span>")).toBeLessThan(html.indexOf(">linux</span>"));
  });

  it.each([undefined, []])("renders %s as unavailable", (labels) => {
    expect(renderToStaticMarkup(<WorktreeLabels worktreeId="empty" labels={labels} />)).toContain(
      "—",
    );
  });
});

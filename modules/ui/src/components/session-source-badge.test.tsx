import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionSourceBadge } from "./session-source-badge.tsx";

describe("SessionSourceBadge", () => {
  it("renders every documented origin as an outlined badge", () => {
    for (const source of ["api", "ui", "webhook", "schedule"]) {
      const html = renderToStaticMarkup(<SessionSourceBadge source={source} />);
      expect(html).toContain(`data-pw="session-source-${source}"`);
      expect(html).toContain(`>${source}</div>`);
      expect(html).toContain("text-foreground");
    }
  });

  it("uses a visible neutral fallback for missing and legacy values", () => {
    for (const source of [null, undefined, "legacy"]) {
      const html = renderToStaticMarkup(<SessionSourceBadge source={source} />);
      expect(html).toContain('data-pw="session-source-unknown"');
      expect(html).toContain(">unknown</div>");
      expect(html).toContain("bg-muted");
    }
  });
});

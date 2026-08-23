import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { activeNavHref, AppNav, navGroups } from "./app-nav.tsx";
import { AppShell } from "./app-shell.tsx";
import { TooltipProvider } from "./tooltip.tsx";

describe("application navigation coverage", () => {
  it("normalizes flat, empty, and grouped navigation and chooses the longest active route", () => {
    expect(navGroups([])).toEqual([{ items: [] }]);
    expect(navGroups([{ href: "/", label: "Home" }])).toEqual([
      { items: [{ href: "/", label: "Home" }] },
    ]);
    const groups = [
      {
        label: "Operate Tools",
        items: [
          { href: "/sessions", label: "Sessions" },
          { href: "/sessions/new", label: "New", pw: "new-session", tip: "Create a session" },
        ],
      },
    ];
    expect(navGroups(groups)).toBe(groups);
    expect(activeNavHref(undefined, groups, [])).toBeNull();
    expect(activeNavHref("/missing", groups, [])).toBeNull();
    expect(activeNavHref("/sessions/new/detail", groups, [])).toBe("/sessions/new");
    expect(activeNavHref("/sessions/import", groups, ["/sessions/import"])).toBe(
      "/sessions/import",
    );
  });

  it("renders grouped and ungrouped active, inactive, tipped, and default navigation items", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <AppNav
          activeHref="/sessions/new"
          groups={[
            {
              items: [
                { href: "/", label: "Home", pw: "custom-home" },
                { href: "/sessions", label: "Sessions", tip: "Browse sessions" },
              ],
            },
            {
              items: [{ href: "/sessions/new", label: "New", pw: "new-session" }],
              label: "Operate Tools",
            },
            { items: [{ href: "/settings", label: "Settings" }], label: "" },
          ]}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('data-pw="custom-home"');
    expect(html).toContain('data-pw="nav-group-operate-tools"');
    expect(html).toContain('data-state="closed"');
  });
});

describe("AppShell coverage", () => {
  const nav = [{ href: "/", label: "Home" }];

  it("renders optional title and subtitle tooltips with a badge", () => {
    const html = renderToStaticMarkup(
      <AppShell
        title="Harness"
        titleTip="Control plane"
        subtitle="Operations"
        subtitleTip="Current workspace"
        titleBadge={<span>Ready</span>}
        nav={nav}
        pathname="/"
        className="custom"
        pw="shell"
      >
        Content
      </AppShell>,
    );
    expect(html).toContain('data-state="closed"');
    expect(html).toContain("Ready");
    expect(html).toContain("custom");
  });

  it("renders plain headings, badge-only rows, and no secondary row", () => {
    expect(
      renderToStaticMarkup(
        <AppShell title="Plain" titleBadge={<span>Badge</span>} nav={nav}>
          Content
        </AppShell>,
      ),
    ).toContain("Badge");
    const plain = renderToStaticMarkup(
      <AppShell title="Plain" subtitle="Subtitle" nav={nav}>
        Content
      </AppShell>,
    );
    expect(plain).toContain("Subtitle");
    expect(
      renderToStaticMarkup(
        <AppShell title="Plain" nav={nav}>
          Content
        </AppShell>,
      ),
    ).not.toContain('data-pw="app-subtitle"');
  });
});

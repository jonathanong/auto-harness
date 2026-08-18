// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { ControlShell } from "./control-shell.tsx";

describe("ControlShell", () => {
  it("renders its control-plane chrome, children, and active nested route", () => {
    const view = mountForm(<ControlShell>Current sessions</ControlShell>, {
      pathname: "/sessions/session-1",
    });
    expect(field(view.container, "control-shell")).toBeInstanceOf(HTMLDivElement);
    const titleLink = field<HTMLAnchorElement>(view.container, "app-title");
    expect(titleLink.textContent).toBe("Control plane");
    expect(titleLink.tagName).toBe("A");
    expect(titleLink.getAttribute("href")).toBe("/");
    expect(field(view.container, "app-subtitle").textContent).toContain("host fleet");
    expect(view.container.textContent).toContain("Operate");
    expect(view.container.textContent).toContain("Catalog");
    expect(view.container.textContent).toContain("Fleet");
    expect(field(view.container, "app-main").textContent).toContain("Current sessions");
    expect(field<HTMLAnchorElement>(view.container, "nav-sessions").className).toContain(
      "bg-muted",
    );
    expect(field<HTMLAnchorElement>(view.container, "nav-dashboard").getAttribute("href")).toBe(
      "/",
    );
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").getAttribute("href")).toBe(
      "/sessions/new",
    );
    expect(field<HTMLAnchorElement>(view.container, "nav-hosts").getAttribute("href")).toBe(
      "/hosts",
    );
    view.unmount();
  });

  it("highlights only New session, not Sessions, on /sessions/new", () => {
    const view = mountForm(<ControlShell>New session</ControlShell>, {
      pathname: "/sessions/new",
    });
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").className).toContain(
      "bg-muted text-foreground",
    );
    expect(field<HTMLAnchorElement>(view.container, "nav-sessions").className).not.toContain(
      "bg-muted text-foreground",
    );
    view.unmount();
  });

  it("shows a scroll-fade hint only on the edge with more nav content off-screen", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const view = mountForm(<ControlShell>Dashboard</ControlShell>, { pathname: "/" });
    const nav = view.container.querySelector('[data-pw="app-nav"]') as HTMLElement;
    Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 900 });
    Object.defineProperty(nav, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(nav, "scrollLeft", { configurable: true, value: 0, writable: true });

    act(() => nav.dispatchEvent(new Event("scroll")));
    expect(view.container.querySelector('[data-pw="app-nav-fade-left"]')).toBeNull();
    expect(view.container.querySelector('[data-pw="app-nav-fade-right"]')).not.toBeNull();

    act(() => {
      (nav as unknown as { scrollLeft: number }).scrollLeft = 250;
      nav.dispatchEvent(new Event("scroll"));
    });
    expect(view.container.querySelector('[data-pw="app-nav-fade-left"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="app-nav-fade-right"]')).not.toBeNull();
    view.unmount();
  });

  it("uses the dashboard route when Next has no pathname", () => {
    const view = mountForm(<ControlShell>Dashboard</ControlShell>, { pathname: null });
    expect(field<HTMLAnchorElement>(view.container, "nav-dashboard").className).toContain(
      "bg-muted",
    );
    view.unmount();
  });

  it("renders login content without the authenticated control-plane chrome", () => {
    const view = mountForm(<ControlShell>Sign in</ControlShell>, { pathname: "/login" });
    expect(view.container.textContent).toBe("Sign in");
    expect(view.container.querySelector('[data-pw="control-shell"]')).toBeNull();
    view.unmount();
  });
});

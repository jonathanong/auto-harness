// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { ControlShell } from "./control-shell.tsx";

describe("ControlShell", () => {
  it("renders its control-plane chrome, children, and active nested route", () => {
    const view = mountForm(<ControlShell>Current sessions</ControlShell>, {
      pathname: "/sessions/session-1",
    });
    expect(field(view.container, "control-shell")).toBeInstanceOf(HTMLDivElement);
    expect(field(view.container, "app-title").textContent).toBe("Control plane");
    expect(field(view.container, "app-subtitle").textContent).toContain("host fleet");
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

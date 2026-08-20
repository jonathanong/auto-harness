// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { ControlShell } from "./control-shell.tsx";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

function openNavGroup(container: ParentNode, pw: string) {
  act(() => {
    const trigger = field<HTMLButtonElement>(container, pw);
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}

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
    expect(view.container.innerHTML.toLowerCase()).not.toContain("host pane");
    expect(field(view.container, "nav-group-operate").textContent).toContain("Operate");
    expect(field(view.container, "nav-group-catalog").textContent).toContain("Catalog");
    expect(field(view.container, "nav-group-fleet").textContent).toContain("Fleet");
    expect(field(view.container, "nav-group-settings").textContent).toContain("Settings");
    expect(field(view.container, "app-main").textContent).toContain("Current sessions");
    expect(field(view.container, "nav-group-operate").className).toContain("bg-muted");
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").getAttribute("href")).toBe(
      "/sessions/new",
    );
    openNavGroup(view.container, "nav-group-operate");
    expect(field<HTMLAnchorElement>(document, "nav-sessions").className).toContain("bg-muted");
    expect(field<HTMLAnchorElement>(document, "nav-dashboard").getAttribute("href")).toBe("/");
    openNavGroup(view.container, "nav-group-fleet");
    expect(field<HTMLAnchorElement>(document, "nav-hosts").getAttribute("href")).toBe("/hosts");
    view.unmount();
  });

  it("highlights only New session, not Sessions, on /sessions/new", () => {
    const view = mountForm(<ControlShell>New session</ControlShell>, {
      pathname: "/sessions/new",
    });
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").className).toContain(
      "bg-muted text-foreground",
    );
    expect(field(view.container, "nav-group-operate").className).not.toContain(
      "bg-muted text-foreground",
    );
    openNavGroup(view.container, "nav-group-operate");
    expect(field<HTMLAnchorElement>(document, "nav-sessions").className).not.toContain(
      "bg-muted text-foreground",
    );
    view.unmount();
  });

  it("highlights New session for nested create routes and leaves Operate inactive", () => {
    const view = mountForm(<ControlShell>New session</ControlShell>, {
      pathname: "/sessions/new/preview",
    });
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").className).toContain(
      "bg-muted text-foreground",
    );
    expect(field(view.container, "nav-group-operate").className).not.toContain(
      "bg-muted text-foreground",
    );
    view.unmount();
  });

  it("uses the dashboard route when Next has no pathname", () => {
    const view = mountForm(<ControlShell>Dashboard</ControlShell>, { pathname: null });
    expect(field(view.container, "nav-group-operate").className).toContain("bg-muted");
    openNavGroup(view.container, "nav-group-operate");
    expect(field<HTMLAnchorElement>(document, "nav-dashboard").className).toContain("bg-muted");
    view.unmount();
  });

  it("renders login content without the authenticated control-plane chrome", () => {
    const view = mountForm(<ControlShell>Sign in</ControlShell>, { pathname: "/login" });
    expect(view.container.textContent).toBe("Sign in");
    expect(view.container.querySelector('[data-pw="control-shell"]')).toBeNull();
    view.unmount();
  });

  it("hides logout when authentication is not required", () => {
    const view = mountForm(<ControlShell>Dashboard</ControlShell>, { pathname: "/" });
    expect(view.container.querySelector('[data-pw="logout"]')).toBeNull();
    expect(field<HTMLAnchorElement>(view.container, "nav-session-new").className).not.toContain(
      "bg-muted text-foreground",
    );
    view.unmount();
  });

  it("shows logout when authentication is required", () => {
    const view = mountForm(<ControlShell authRequired>Dashboard</ControlShell>, {
      pathname: "/",
    });
    expect(field(view.container, "logout")).toBeInstanceOf(HTMLButtonElement);
    view.unmount();
  });
});

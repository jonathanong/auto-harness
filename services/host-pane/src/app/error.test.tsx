// @vitest-environment happy-dom

import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ErrorPage from "./error.tsx";
import GlobalError from "./global-error.tsx";

vi.mock("../lib/sentry-client.ts", () => ({
  reportClientError: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

describe("host-pane error surfaces", () => {
  it("reports the error, hides private details, and retries", async () => {
    const { reportClientError } = await import("../lib/sentry-client.ts");
    const reset = vi.fn();
    const error = new Error("private detail");
    const page = mount(<ErrorPage error={error} reset={reset} />);
    expect(reportClientError).toHaveBeenCalledWith(error);
    expect(page.textContent).toContain("could not be loaded");
    expect(page.textContent).not.toContain("private detail");
    page.querySelector("button")?.click();
    expect(reset).toHaveBeenCalledOnce();

    const globalReset = vi.fn();
    const global = mount(<GlobalError error={error} reset={globalReset} />);
    expect(global.textContent).not.toContain("private detail");
    global.querySelector("button")?.click();
    expect(globalReset).toHaveBeenCalledOnce();
  });
});

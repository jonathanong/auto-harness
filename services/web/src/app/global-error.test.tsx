// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { mountForm } from "../components/form-test-helpers.tsx";
import GlobalError from "./global-error.tsx";

vi.mock("../lib/sentry-client.ts", () => ({
  reportClientError: vi.fn(),
}));

describe("web global error", () => {
  it("reports the error and retries without showing private details", async () => {
    const { reportClientError } = await import("../lib/sentry-client.ts");
    const reset = vi.fn();
    const error = new Error("private detail");
    const view = mountForm(<GlobalError error={error} reset={reset} />);
    expect(reportClientError).toHaveBeenCalledWith(error);
    expect(view.container.textContent).toContain("could not be loaded");
    expect(view.container.textContent).not.toContain("private detail");
    view.container.querySelector("button")?.click();
    expect(reset).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it } from "vitest";

import { ApiError, isUnauthenticatedError } from "./api.ts";
import {
  HOST_PANE_UNAUTHENTICATED_BODY,
  HOST_PANE_UNAUTHENTICATED_HEADING,
  hostPaneUnauthenticatedHtml,
} from "./unauthenticated.ts";

describe("host-pane unauthenticated copy", () => {
  it("renders HTML that explains debug-only and the control plane", () => {
    const html = hostPaneUnauthenticatedHtml();
    expect(html).toMatch(/<!DOCTYPE html>/i);
    expect(html).toContain(HOST_PANE_UNAUTHENTICATED_HEADING);
    expect(html).toContain(HOST_PANE_UNAUTHENTICATED_BODY);
    expect(html).toMatch(/debug/i);
    expect(html).toMatch(/control plane/i);
  });

  it("treats only API 401 as unauthenticated", () => {
    expect(isUnauthenticatedError(new ApiError("/api/v1/hosts", 401))).toBe(true);
    expect(isUnauthenticatedError(new ApiError("/api/v1/hosts", 500))).toBe(false);
    expect(isUnauthenticatedError(new Error("authentication required"))).toBe(false);
  });
});

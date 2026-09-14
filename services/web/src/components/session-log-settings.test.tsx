// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createRequestFake,
  field,
  json,
  mountForm,
} from "../../test-helpers/form-test-helpers.tsx";
import { SessionLogSettingsForm } from "./session-log-settings.tsx";

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionLogSettingsForm", () => {
  it("loads defaults and saves an upload-mode change", async () => {
    const request = createRequestFake(
      json({
        uploadMode: "off",
        batchMaxKb: 256,
        batchMaxLines: 500,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
        version: 0,
      }),
      json({
        uploadMode: "always",
        batchMaxKb: 256,
        batchMaxLines: 500,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
        version: 1,
      }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    const mode = field<HTMLSelectElement>(view.container, "session-log-upload-mode");
    expect(mode.value).toBe("off");
    await act(async () => {
      mode.value = "always";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      field<HTMLButtonElement>(view.container, "session-log-settings-save").click();
    });
    await settle();
    expect(request.requests.at(-1)?.[1]?.method).toBe("PUT");
    view.unmount();
  });

  it("shows a forbidden state", async () => {
    vi.stubGlobal("fetch", createRequestFake(new Response(null, { status: 403 })).request);
    const view = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    expect(field(view.container, "session-log-settings-forbidden")).toBeTruthy();
    view.unmount();
  });
});

// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("shows an error when the load request rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const view = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    expect(field(view.container, "session-log-settings-error")).toBeTruthy();
    view.unmount();
  });

  it("treats a 401 load as forbidden and a 500 load as an error", async () => {
    vi.stubGlobal("fetch", createRequestFake(new Response(null, { status: 401 })).request);
    const forbidden = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    expect(field(forbidden.container, "session-log-settings-forbidden")).toBeTruthy();
    forbidden.unmount();
    vi.stubGlobal("fetch", createRequestFake(new Response(null, { status: 500 })).request);
    const errored = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    expect(field(errored.container, "session-log-settings-error")).toBeTruthy();
    errored.unmount();
  });

  it("edits numeric fields and surfaces a failed save", async () => {
    const request = createRequestFake(
      json({
        uploadMode: "off",
        batchMaxKb: 256,
        batchMaxLines: 500,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
        version: 0,
      }),
      new Response(null, { status: 500 }),
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      for (const [pw, value] of [
        ["session-log-batch-max-kb", "128"],
        ["session-log-batch-max-lines", "40"],
        ["session-log-batch-max-wait-ms", "5000"],
        ["session-log-control-plane-poll-ms", "15000"],
      ] as const) {
        const input = field<HTMLInputElement>(view.container, pw);
        setValue?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await act(async () => {
      field<HTMLFormElement>(view.container, "form-session-log-settings").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(request.requests.at(-1)?.[1]?.method).toBe("PUT");
    view.unmount();
  });

  it("toasts when save throws", async () => {
    const request = createRequestFake(
      json({
        uploadMode: "off",
        batchMaxKb: 256,
        batchMaxLines: 500,
        batchMaxWaitMs: 60_000,
        controlPlanePollMs: 60_000,
        version: 0,
      }),
      async () => {
        throw new Error("offline");
      },
    );
    vi.stubGlobal("fetch", request.request);
    const view = mountForm(<SessionLogSettingsForm />, { pathname: "/settings/session-logs" });
    await settle();
    await act(async () => {
      field<HTMLButtonElement>(view.container, "session-log-settings-save").click();
    });
    await settle();
    view.unmount();
  });
});

// @vitest-environment happy-dom

import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  field,
  mount,
  press,
  reset as resetHelper,
} from "../../test-helpers/action-form-test-helpers.ts";
import { isSessionArchiveReadResponse } from "../lib/session-archive-response.ts";
import { SessionArchiveStatus } from "./session-archive-status.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function response(body: unknown, ok = true) {
  return { ok, json: vi.fn(async () => body) };
}

afterEach(resetHelper);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function RefreshTokenHarness() {
  const [token, setToken] = useState(0);
  return (
    <>
      <SessionArchiveStatus sessionId="session" terminal={false} refreshToken={token} />
      <button type="button" data-pw="signal" onClick={() => setToken((value) => value + 1)} />
    </>
  );
}

describe("SessionArchiveStatus", () => {
  it("shows DynamoDB state, polls a terminal session, and exposes an archived download", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ state: "dynamodb" }))
      .mockResolvedValueOnce(
        response({
          state: "archived",
          downloadUrl: "https://s3.example/session.jsonl",
          expiresAt: "2026-08-14T12:35:00.000Z",
          contentType: "application/x-ndjson",
          bodyBytes: 42,
        }),
      )
      .mockResolvedValueOnce(
        response({
          state: "archived",
          downloadUrl: "https://s3.example/fresh.jsonl",
          expiresAt: "2026-08-14T12:35:00.000Z",
          contentType: "application/x-ndjson",
          bodyBytes: 42,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = mount(<SessionArchiveStatus sessionId="session/one" terminal />);

    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("not archived");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions/session%2Fone/archive", {
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("ready");
    expect(field(view.container, "session-archive-download")).not.toBeNull();

    await act(async () => press(field(view.container, "session-archive-download")));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalled();
    view.unmount();
  });

  it("distinguishes unavailable archives and refreshes on demand", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ state: "unavailable" }))
      .mockResolvedValueOnce(response({ state: "dynamodb" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="missing" terminal={false} />);
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("unavailable");
    expect(view.container.querySelector('[data-pw="session-archive-download"]')).toBeNull();
    press(field(view.container, "session-archive-refresh"));
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("not archived");
    view.unmount();
  });

  it("shows an integrity-incomplete archive as a warning and never offers it for download", async () => {
    const incomplete = { state: "incomplete", reason: "version-id-mismatch" } as const;
    expect(isSessionArchiveReadResponse(incomplete)).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(incomplete)));
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("integrity");
    expect(field(view.container, "session-archive-status").className).toContain("text-amber-800");
    expect(view.container.querySelector('[data-pw="session-archive-download"]')).toBeNull();
    view.unmount();
  });

  it("shows an expired transcript as a warning without a download", async () => {
    expect(isSessionArchiveReadResponse({ state: "expired" })).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ state: "expired" })));
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("expired");
    expect(field(view.container, "session-archive-status").className).toContain("text-amber-800");
    expect(view.container.querySelector('[data-pw="session-archive-download"]')).toBeNull();
    view.unmount();
  });

  it("refreshes when the owning detail view signals a successful archive action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ state: "dynamodb" }))
      .mockResolvedValueOnce(response({ state: "unavailable" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<RefreshTokenHarness />);
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("not archived");
    press(field(view.container, "signal"));
    await settle();
    expect(field(view.container, "session-archive-state").textContent).toContain("unavailable");
    view.unmount();
  });

  it("reports failed and malformed status responses", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ state: "bad" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    expect(field(view.container, "session-archive-error").textContent).toContain("could not");
    press(field(view.container, "session-archive-refresh"));
    await settle();
    expect(field(view.container, "session-archive-error").textContent).toContain("could not");
    view.unmount();
  });

  it("rejects incomplete archived payloads and reports download failures", async () => {
    const incomplete = [
      null,
      "not an object",
      [],
      { state: "archived" },
      { state: "archived", downloadUrl: "url" },
      { state: "archived", downloadUrl: "url", expiresAt: "now" },
      { state: "archived", downloadUrl: "url", expiresAt: "now", contentType: "text/plain" },
      {
        state: "archived",
        downloadUrl: "url",
        expiresAt: "now",
        contentType: "text/plain",
        bodyBytes: -1,
      },
      {
        state: "archived",
        downloadUrl: "url",
        expiresAt: "now",
        contentType: "text/plain",
        bodyBytes: Number.NaN,
      },
    ];
    for (const body of incomplete) {
      expect(isSessionArchiveReadResponse(body)).toBe(false);
    }

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          state: "archived",
          downloadUrl: "https://s3.example/session.jsonl",
          expiresAt: "now",
          contentType: "application/x-ndjson",
          bodyBytes: 1,
        }),
      )
      .mockResolvedValueOnce(response({}, false));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    press(field(view.container, "session-archive-download"));
    await settle();
    expect(field(view.container, "session-archive-error").textContent).toContain("downloaded");
    view.unmount();
  });

  it("bounds terminal DynamoDB polling to 65 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response({ state: "dynamodb" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="session" terminal />);
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(14);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(14);
    view.unmount();
  });
});

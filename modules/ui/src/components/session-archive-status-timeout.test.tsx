// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  field,
  mount,
  press,
  reset as resetHelper,
} from "../../test-helpers/action-form-test-helpers.ts";
import { ARCHIVE_REQUEST_TIMEOUT_MS, SessionArchiveStatus } from "./session-archive-status.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(resetHelper);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionArchiveStatus request timeout", () => {
  it("aborts a stalled archive status fetch and recovers for a later refresh", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    expect((field(view.container, "session-archive-refresh") as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => vi.advanceTimersByTimeAsync(ARCHIVE_REQUEST_TIMEOUT_MS));
    await settle();
    expect(field(view.container, "session-archive-error").textContent).toContain("could not");
    expect((field(view.container, "session-archive-refresh") as HTMLButtonElement).disabled).toBe(
      false,
    );
    view.unmount();
  });

  it("aborts a stalled archive response body and cancels in-flight work on unmount", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const next = init?.signal;
      if (next) signal = next;
      return Promise.resolve({
        ok: true,
        json: () =>
          new Promise((_, reject) => {
            next?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = mount(<SessionArchiveStatus sessionId="session" terminal={false} />);
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(ARCHIVE_REQUEST_TIMEOUT_MS));
    await settle();
    expect(field(view.container, "session-archive-error").textContent).toContain("could not");
    fetchMock.mockClear();
    press(field(view.container, "session-archive-refresh"));
    await settle();
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

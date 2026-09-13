// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  field,
  mount,
  press,
  reset as resetHelper,
} from "../../test-helpers/action-form-test-helpers.ts";
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

describe("SessionArchiveStatus injected request", () => {
  it("uses an injected request for status and download", async () => {
    const archived = {
      state: "archived",
      downloadUrl: "https://s3.example/session.jsonl",
      expiresAt: "now",
      contentType: "application/x-ndjson",
      bodyBytes: 1,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(archived))
      .mockResolvedValueOnce(response({}, false));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = mount(
      <SessionArchiveStatus sessionId="session" terminal={false} request={request} />,
    );
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "/api/v1/sessions/session/archive", {
      cache: "no-store",
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });
    press(field(view.container, "session-archive-download"));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(click).not.toHaveBeenCalled();
    expect(field(view.container, "session-archive-error").textContent).toContain("downloaded");
    view.unmount();
  });
});

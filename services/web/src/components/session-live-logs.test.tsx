// @vitest-environment happy-dom

import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { field, mountForm } from "../../test-helpers/form-test-helpers.tsx";
import { SessionLiveLogs } from "./session-live-logs.tsx";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SessionLiveLogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("polls REST logs and notes the S3 delay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/logs")
          ? Response.json({
              items: [
                {
                  timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
                  seq: 1,
                  stream: "stdout",
                  content: "hello",
                  timestamp: "2026-01-01T00:00:00.000Z",
                },
              ],
            })
          : Response.json({ status: "completed" }),
      ),
    );
    const view = mountForm(
      <SessionLiveLogs sessionId="session-1" initialItems={[]} initialStatus="running" />,
    );
    await settle();
    expect(field(view.container, "session-logs-s3-note").textContent).toContain("host pane");
    expect(field(view.container, "session-logs-live-state").textContent).toBe("completed");
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });
});

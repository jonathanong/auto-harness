// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const initBrowserSentry = vi.hoisted(() => vi.fn());

vi.mock("../lib/sentry-client.ts", () => ({ initBrowserSentry }));

import { SentryClientInit } from "./sentry-client-init.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.replaceChildren();
  initBrowserSentry.mockReset();
});

describe("host-pane SentryClientInit", () => {
  it("inits the browser SDK once mounted", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SentryClientInit dsn="https://abc123@o1.ingest.sentry.io/450" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(initBrowserSentry).toHaveBeenCalledWith("https://abc123@o1.ingest.sentry.io/450");
    await act(async () => {
      root.unmount();
    });
  });
});

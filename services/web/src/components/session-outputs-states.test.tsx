// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionOutputs } from "./session-outputs.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionOutputs sessionId="session/a" />));
  return { container, unmount: () => act(() => root.unmount()) };
}

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SessionOutputs states", () => {
  it.each([
    [null, "null"],
    [false, "false"],
    [0, "0"],
    [["one", 2], '[\n  "one",\n  2\n]'],
  ])("renders JSON value %j as safe text", async (value, expected) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ state: "ready", output: value, capturedAt: "now" }))
        .mockResolvedValueOnce(json({ state: "none" })),
    );
    const view = mount();
    await settle();
    expect(view.container.querySelector("pre")?.textContent).toBe(expected);
    view.unmount();
  });

  it("shows unsupported, pending, and API error statuses explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ state: "unsupported" }))
        .mockResolvedValueOnce(
          json({ state: "error", error: { code: "TOO_LARGE", message: "Too large" } }),
        ),
    );
    const view = mount();
    await settle();
    expect(view.container.textContent).toContain("Outputs are not supported by this host.");
    expect(view.container.textContent).toContain("Too large (TOO_LARGE)");
    view.unmount();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ state: "pending" }))
        .mockResolvedValueOnce(json({ state: "pending" })),
    );
    const pendingView = mount();
    await settle();
    expect(pendingView.container.textContent).toContain("Output is still being collected.");
    expect(
      pendingView.container.querySelector('[data-pw="session-output-refresh"]'),
    ).not.toBeNull();
    pendingView.unmount();
  });

  it("surfaces transport failures separately from output state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const view = mount();
    await settle();
    expect(
      view.container.querySelector('[data-pw="session-output-fetch-error"]')?.textContent,
    ).toBe("offline");
    expect(
      view.container.querySelector('[data-pw="session-artifacts-fetch-error"]')?.textContent,
    ).toBe("offline");
    view.unmount();
  });

  it("reports deeply nested JSON that cannot be formatted", async () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 20_000; depth += 1) nested = [nested];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ state: "ready", output: nested, capturedAt: "now" }))
        .mockResolvedValueOnce(json({ state: "none" })),
    );
    const view = mount();
    await settle();
    expect(
      view.container.querySelector('[data-pw="session-output-render-error"]')?.textContent,
    ).toBe("Captured output is too deeply nested to display.");
    view.unmount();
  });
  it("displays capture errors separately from unsupported artifacts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          json({ state: "error", error: { code: "INVALID_JSON", message: "Invalid JSON" } }),
        )
        .mockResolvedValueOnce(json({ state: "unsupported" })),
    );
    const view = mount();
    await settle();
    expect(view.container.textContent).toContain("Invalid JSON (INVALID_JSON)");
    expect(view.container.textContent).toContain("Artifacts are not supported by this host.");
    view.unmount();
  });
});

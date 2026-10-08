// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionOutputs } from "./session-outputs.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function mount(sessionId = "session/a") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<SessionOutputs sessionId={sessionId} />));
  return {
    container,
    update(nextSessionId: string) {
      act(() => root.render(<SessionOutputs sessionId={nextSessionId} />));
    },
    unmount: () => act(() => root.unmount()),
  };
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
  vi.useRealTimers();
});

describe("SessionOutputs", () => {
  it("fetches a fresh artifact URL only on download and never renders the URL", async () => {
    const ready = {
      state: "ready",
      downloadUrl: "https://bucket.test/signed?credential=secret",
      expiresAt: "soon",
      capturedAt: "now",
      contentType: "application/gzip",
      filename: "artifacts.tar.gz",
      compressedBytes: 50,
      sha256: "sha",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ state: "none" }))
      .mockResolvedValueOnce(json(ready))
      .mockResolvedValueOnce(json(ready));
    vi.stubGlobal("fetch", fetchMock);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = mount();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).not.toContain("credential=secret");
    expect(view.container.querySelector('[data-pw="session-artifacts-download"]')).not.toBeNull();

    await act(async () => {
      (
        view.container.querySelector('[data-pw="session-artifacts-download"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(click).toHaveBeenCalledOnce();
    expect(view.container.textContent).not.toContain("credential=secret");
    expect(view.container.querySelector("a")).toBeNull();
    view.unmount();
  });

  it("bounds automatic pending polls and exposes a manual refresh control", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => json({ state: "pending" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount();
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(24);
    expect(view.container.querySelector('[data-pw="session-output-poll-paused"]')).not.toBeNull();
    expect(view.container.querySelector('[data-pw="session-output-refresh"]')).not.toBeNull();
    view.unmount();
  });

  it("offers refresh after transport failures and recovers when retried", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, false))
      .mockResolvedValueOnce(json({}, false))
      .mockResolvedValueOnce(
        json({ state: "ready", output: { recovered: true }, capturedAt: "now" }),
      )
      .mockResolvedValueOnce(json({ state: "none" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount();
    await settle();
    expect(view.container.querySelector('[data-pw="session-output-refresh"]')).not.toBeNull();
    await act(async () => {
      (
        view.container.querySelector('[data-pw="session-output-refresh"]') as HTMLButtonElement
      ).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-pw="session-output-ready"]')?.textContent).toContain(
      '"recovered": true',
    );
    expect(view.container.querySelector('[data-pw="session-output-fetch-error"]')).toBeNull();
    view.unmount();
  });

  it("ignores a slower response after the selected session changes", async () => {
    let finishOldOutput!: (value: ReturnType<typeof json>) => void;
    let finishOldArtifacts!: (value: ReturnType<typeof json>) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (finishOldOutput = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (finishOldArtifacts = resolve)))
      .mockResolvedValueOnce(json({ state: "ready", output: "new", capturedAt: "now" }))
      .mockResolvedValueOnce(json({ state: "none" }));
    vi.stubGlobal("fetch", fetchMock);
    const view = mount("old-session");
    view.update("new-session");
    await settle();
    expect(view.container.querySelector("pre")?.textContent).toBe('"new"');
    await act(async () => {
      finishOldOutput(json({ state: "ready", output: "old", capturedAt: "old" }));
      finishOldArtifacts(json({ state: "none" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector("pre")?.textContent).toBe('"new"');
    view.unmount();
  });
  it.each(["revoked", "offline"])(
    "handles a %s artifact download without using an old URL",
    async (outcome) => {
      const ready = {
        state: "ready",
        downloadUrl: "https://bucket.test/old",
        expiresAt: "soon",
        capturedAt: "now",
        contentType: "application/gzip",
        filename: "artifacts.tar.gz",
        compressedBytes: 50,
        sha256: "sha",
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(json({ state: "none" }))
        .mockResolvedValueOnce(json(ready));
      if (outcome === "revoked") fetchMock.mockResolvedValueOnce(json({ state: "none" }));
      else fetchMock.mockRejectedValueOnce(new Error("download offline"));
      vi.stubGlobal("fetch", fetchMock);
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const view = mount();
      await settle();
      await act(async () => {
        (
          view.container.querySelector(
            '[data-pw="session-artifacts-download"]',
          ) as HTMLButtonElement
        ).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(click).not.toHaveBeenCalled();
      if (outcome === "revoked")
        expect(view.container.textContent).toContain("No artifacts were captured");
      else
        expect(
          view.container.querySelector('[data-pw="session-artifacts-download-error"]')?.textContent,
        ).toBe("download offline");
      view.unmount();
    },
  );
});

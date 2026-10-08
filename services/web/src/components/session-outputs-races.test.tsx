// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionOutputs } from "./session-outputs.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const ready = {
  state: "ready",
  downloadUrl: "https://example.test/old",
  expiresAt: "soon",
  capturedAt: "now",
  filename: "artifacts.tar.gz",
  compressedBytes: 50,
  sha256: "sha",
};

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

describe("session output request lifetimes", () => {
  it.each(["resolve", "reject"])(
    "ignores an old-session download that later %ss",
    async (outcome) => {
      let resolveDownload!: (value: ReturnType<typeof json>) => void;
      let rejectDownload!: (reason: Error) => void;
      const pending = new Promise<ReturnType<typeof json>>((resolve, reject) => {
        resolveDownload = resolve;
        rejectDownload = reject;
      });
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json({ state: "none" }))
        .mockResolvedValueOnce(json(ready))
        .mockReturnValueOnce(pending)
        .mockResolvedValueOnce(json({ state: "ready", output: "new session", capturedAt: "now" }))
        .mockResolvedValueOnce(json({ state: "none" }));
      vi.stubGlobal("fetch", transport);
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      act(() => root.render(<SessionOutputs sessionId="old" />));
      await settle();
      act(() =>
        (
          container.querySelector('[data-pw="session-artifacts-download"]') as HTMLButtonElement
        ).click(),
      );
      act(() => root.render(<SessionOutputs sessionId="new" />));
      await settle();
      await act(async () => {
        if (outcome === "resolve") resolveDownload(json(ready));
        else rejectDownload(new Error("old download failed"));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(click).not.toHaveBeenCalled();
      expect(container.querySelector("pre")?.textContent).toBe('"new session"');
      expect(container.querySelector('[data-pw="session-artifacts-download-error"]')).toBeNull();
      act(() => root.unmount());
    },
  );

  it.each(["null body", "non-Error rejection"])(
    "shows a recoverable failure for %s",
    async (failure) => {
      const transport =
        failure === "null body"
          ? vi.fn().mockResolvedValue(json(null))
          : vi.fn().mockRejectedValue("transport failed");
      vi.stubGlobal("fetch", transport);
      const container = document.createElement("div");
      const root = createRoot(container);
      act(() => root.render(<SessionOutputs sessionId="malformed" />));
      await settle();
      expect(container.querySelector('[data-pw="session-output-fetch-error"]')?.textContent).toBe(
        "Output request failed",
      );
      expect(
        container.querySelector('[data-pw="session-artifacts-fetch-error"]')?.textContent,
      ).toBe("Artifacts request failed");
      expect(container.querySelector('[data-pw="session-output-refresh"]')).not.toBeNull();
      act(() => root.unmount());
    },
  );
});

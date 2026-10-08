// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { SessionOutputResponse } from "@auto-harness/shared";
import { ArtifactState, OutputState, type ArtifactStatus } from "./session-output-state.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it("keeps unfamiliar API states from displaying output or artifact data", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <>
          <OutputState response={{ state: "future-state" } as unknown as SessionOutputResponse} />
          <ArtifactState response={{ state: "future-state" } as unknown as ArtifactStatus} />
        </>,
      ),
    );
    expect(container.textContent).toBe("");
    expect(container.querySelector("pre")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("displays a missing ready payload without crashing the session view", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <OutputState response={{ state: "ready", output: undefined, capturedAt: "now" }} />,
      ),
    );
    expect(container.querySelector("pre")?.textContent).toBe("undefined");
  } finally {
    act(() => root.unmount());
  }
});

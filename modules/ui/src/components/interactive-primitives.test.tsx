// @vitest-environment happy-dom

import { createRoot } from "react-dom/client";
import { act, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmButton } from "./confirm-button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.tsx";
import { CursorPagination } from "./cursor-pagination.tsx";
import { TooltipProvider, WithTooltip } from "./tooltip.tsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    unmount: () => act(() => root.unmount()),
  };
}

function ExampleDialog() {
  const [open, setOpen] = useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-pw="example-dialog">
        <DialogHeader className="header-marker">
          <DialogTitle>Session details</DialogTitle>
          <DialogDescription>Inspect the latest run.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("interactive shared UI primitives", () => {
  it("renders tooltip wrappers for enabled and disabled controls", () => {
    const plain = renderToStaticMarkup(
      <WithTooltip tip="">
        <button type="button">Plain</button>
      </WithTooltip>,
    );
    expect(plain).toContain(">Plain</button>");

    const markup = renderToStaticMarkup(
      <TooltipProvider delayDuration={0}>
        <WithTooltip tip="Explain this action" side="right">
          <button type="button">Enabled</button>
        </WithTooltip>
        <WithTooltip tip="Unavailable" asChild={false}>
          <button type="button" disabled>
            Disabled
          </button>
        </WithTooltip>
      </TooltipProvider>,
    );
    expect(markup).toContain("Enabled");
    expect(markup).toContain('class="inline-flex cursor-not-allowed"');
    expect(markup).toContain("Disabled");
  });

  it("opens and closes an accessible dialog through its close control", () => {
    const view = mount(<ExampleDialog />);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    if (!dialog) throw new Error("dialog did not render");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.textContent).toContain("Session details");
    expect(dialog.textContent).toContain("Inspect the latest run.");
    expect(dialog.querySelector('[data-pw="dialog-close"]')).not.toBeNull();

    act(() => {
      (dialog.querySelector('[data-pw="dialog-close"]') as HTMLButtonElement).click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.unmount();
  });

  it("requires confirmation, exposes pending state, and supports cancellation", async () => {
    let resolve!: () => void;
    const confirmed = vi.fn(() => new Promise<void>((done) => (resolve = done)));
    expect(
      renderToStaticMarkup(
        <TooltipProvider>
          <ConfirmButton
            triggerLabel="Remove host"
            confirmTitle="Remove this host?"
            tip="Permanently remove the host"
            disabled
            onConfirm={confirmed}
          />
        </TooltipProvider>,
      ),
    ).toContain("Remove host");
    const view = mount(
      <ConfirmButton
        triggerLabel="Remove host"
        confirmTitle="Remove this host?"
        confirmDescription="This cannot be undone."
        confirmLabel="Remove now"
        onConfirm={confirmed}
        pw="remove-host"
      />,
    );

    const trigger = view.container.querySelector('[data-pw="remove-host"]') as HTMLButtonElement;
    act(() => trigger.click());
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "This cannot be undone.",
    );
    const submit = document.body.querySelector(
      '[data-pw="remove-host-confirm-submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    expect(confirmed).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Removing…");
    await act(async () => resolve());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    act(() => trigger.click());
    act(() => {
      const cancel = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel",
      );
      cancel?.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.unmount();
  });

  it("keeps confirmation open and reports failed or rejected actions", async () => {
    const attempts = [
      async () => ({ ok: false as const, error: "host is busy" }),
      async () => Promise.reject(new Error("service unavailable")),
      async () => Promise.reject(new Error()),
      async () => Promise.reject("offline"),
    ];
    const expected = ["host is busy", "service unavailable", "request failed", "request failed"];

    for (const [index, onConfirm] of attempts.entries()) {
      const pw = index === 0 ? undefined : "failed-confirm";
      const view = mount(
        <ConfirmButton
          triggerLabel="Remove host"
          confirmTitle="Remove this host?"
          onConfirm={onConfirm}
          pw={pw}
        />,
      );
      act(() => (view.container.querySelector("button") as HTMLButtonElement).click());
      const dialog = document.body.querySelector(
        `[data-pw="${pw ? `${pw}-confirm` : "confirm-dialog"}"]`,
      ) as HTMLElement;
      const submit = [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove",
      );
      await act(async () => {
        submit?.click();
        await Promise.resolve();
      });
      expect(
        dialog.querySelector(`[data-pw="${pw ? `${pw}-error` : "confirm-error"}"]`)?.textContent,
      ).toBe(expected[index]);
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
      act(() => {
        (dialog.querySelector('[data-pw="dialog-close"]') as HTMLButtonElement).click();
      });
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
      view.unmount();
    }
  });

  it("renders cursor links and disabled boundaries with accessible names", () => {
    const first = renderToStaticMarkup(<CursorPagination nextHref="/sessions?cursor=next" />);
    expect(first).toContain('data-pw="pagination-prev-disabled"');
    expect(first).toContain('href="/sessions?cursor=next"');
    expect(first).toContain('data-pw="pagination-next"');

    const middle = renderToStaticMarkup(
      <CursorPagination prevHref="/sessions?cursor=prev" nextHref="/sessions?cursor=next" />,
    );
    expect(middle).toContain('data-pw="pagination-prev"');
    expect(middle).toContain('data-pw="pagination-next"');

    const last = renderToStaticMarkup(<CursorPagination prevHref="/sessions?cursor=prev" />);
    expect(last).toContain('data-pw="pagination-next-disabled"');
    expect(renderToStaticMarkup(<CursorPagination nextHref={null} prevHref={null} />)).toBe("");
  });
});

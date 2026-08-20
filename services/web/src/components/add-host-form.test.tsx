// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { AddHostForm } from "./add-host-form.tsx";

describe("AddHostForm", () => {
  it("validates an absent host id before making a request", () => {
    const view = mountForm(<AddHostForm />);
    const form = field<HTMLFormElement>(view.container, "form-add-host");
    field(view.container, "add-host-id").remove();
    submit(form);
    expect(field(view.container, "add-host-error").textContent).toBe("hostId is required");
    view.unmount();
  });

  it("leaves an existing host untouched and refreshes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AddHostForm />);
    setValue(field(view.container, "add-host-id"), " local/one ");
    submit(field(view.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith("/api/v1/hosts/local%2Fone/inventory", {
      cache: "no-store",
    });
    expect(field(view.container, "add-host-ok").textContent).toContain("already exists");
    expect(router.refresh).toHaveBeenCalledOnce();
    // Regression: this early-return path used to skip setPending(false), leaving the submit
    // button stuck on "Creating…" forever even though nothing is actually pending anymore.
    expect(field<HTMLButtonElement>(view.container, "add-host-submit").disabled).toBe(false);
    view.unmount();
  });

  it("re-enables the submit button and reports an error after a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unreachable")));
    const view = mountForm(<AddHostForm />);
    setValue(field(view.container, "add-host-id"), "new-host");
    submit(field(view.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "add-host-error").textContent).toBe("network unreachable");
    expect(field<HTMLButtonElement>(view.container, "add-host-submit").disabled).toBe(false);
    view.unmount();
  });

  it("creates an empty slot, and reports a failed create while pending", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AddHostForm />);
    setValue(field(view.container, "add-host-id"), "new-host");
    submit(field(view.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(field<HTMLButtonElement>(view.container, "add-host-submit").disabled).toBe(true);
    await act(async () =>
      finish(
        new Response(JSON.stringify({ error: { message: "cannot create" } }), { status: 500 }),
      ),
    );
    expect(field(view.container, "add-host-error").textContent).toBe("cannot create");
    view.unmount();
  });

  it("parses structured API errors and names a 403 as an admin-only action", async () => {
    const forbidden = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "FORBIDDEN", message: "insufficient role for this operation" },
          }),
          { status: 403 },
        ),
      );
    vi.stubGlobal("fetch", forbidden);
    const view = mountForm(<AddHostForm />);
    setValue(field(view.container, "add-host-id"), "new-host");
    submit(field(view.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(field(view.container, "add-host-error").textContent).toBe(
      "Admins create host slots; operators run sessions.",
    );
    expect(field(view.container, "add-host-error").textContent).not.toContain("FORBIDDEN");
    view.unmount();

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("missing", { status: 404 }))
        .mockResolvedValueOnce(new Response("not json", { status: 502 })),
    );
    const fallback = mountForm(<AddHostForm />);
    setValue(field(fallback.container, "add-host-id"), "new-host");
    submit(field(fallback.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(field(fallback.container, "add-host-error").textContent).toBe("not json");
    fallback.unmount();
  });

  it("creates an empty host inventory", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<AddHostForm />);
    setValue(field(view.container, "add-host-id"), "new-host");
    submit(field(view.container, "form-add-host"));
    await act(async () => Promise.resolve());
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      repositories: [],
      providerAccounts: [],
    });
    expect(field(view.container, "add-host-ok").textContent).toContain("created");
    expect(field<HTMLButtonElement>(view.container, "add-host-submit").disabled).toBe(true);
    expect(router.replace).toHaveBeenCalledWith(
      "/hosts/new-host?toast=Host+slot+new-host+created.",
    );
    view.unmount();
  });
});

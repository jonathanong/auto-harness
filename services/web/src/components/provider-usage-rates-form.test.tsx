// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { field, mountForm, router, setValue, submit } from "./form-test-helpers.tsx";
import { ProviderUsageRatesForm } from "./provider-usage-rates-form.tsx";

const provider = {
  id: "provider/one",
  name: "claude",
  defaultCommandId: null,
  createdAt: "now",
  updatedAt: "now",
  usageRates: { currency: "USD", inputTokenMicros: "2" },
};

describe("ProviderUsageRatesForm", () => {
  it("saves operator-configured micros and can clear them", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const view = mountForm(<ProviderUsageRatesForm provider={provider} />);
    setValue(field(document, "provider-usage-rates-currency"), "usd");
    setValue(field(document, "provider-usage-rates-outputTokenMicros"), "3");
    submit(field(document, "form-provider-usage-rates"));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/providers/provider%2Fone",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          usageRates: { currency: "USD", inputTokenMicros: "2", outputTokenMicros: "3" },
        }),
      }),
    );
    field(document, "provider-usage-rates-clear").click();
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/providers/provider%2Fone",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ usageRates: null }) }),
    );
    expect(router.refresh).toHaveBeenCalled();
    view.unmount();
  });

  it("keeps the form open on API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("nope", { status: 400 })),
    );
    const view = mountForm(
      <ProviderUsageRatesForm provider={{ ...provider, usageRates: undefined }} />,
    );
    submit(field(document, "form-provider-usage-rates"));
    await act(async () => Promise.resolve());
    expect(document.querySelector('[data-pw="form-provider-usage-rates"]')).not.toBeNull();
    field(document, "provider-usage-rates-clear").click();
    await act(async () => Promise.resolve());
    expect(document.querySelector('[data-pw="form-provider-usage-rates"]')).not.toBeNull();
    view.unmount();
  });
});

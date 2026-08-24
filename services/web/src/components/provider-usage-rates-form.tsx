"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, showToast } from "@auto-harness/ui";
import { apiBase, apiErrorMessage, type Provider, type UsageRates } from "@auto-harness/shared";

const RATE_FIELDS = [
  ["inputTokenMicros", "Input token micros"],
  ["outputTokenMicros", "Output token micros"],
  ["cachedInputTokenMicros", "Cached input token micros"],
  ["reasoningTokenMicros", "Reasoning token micros"],
] as const;

export function ProviderUsageRatesForm({ provider }: { provider: Provider }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const rates = cleared ? undefined : provider.usageRates;

  return (
    <form
      key={formKey}
      className="grid max-w-md gap-2 rounded-md border p-3"
      data-pw="form-provider-usage-rates"
      onSubmit={(event) => {
        event.preventDefault();
        const fd = new FormData(event.currentTarget);
        const currency = String(fd.get("currency") ?? "")
          .trim()
          .toUpperCase();
        const next: UsageRates = { currency };
        for (const [key] of RATE_FIELDS) {
          const value = String(fd.get(key) ?? "").trim();
          if (value) next[key] = value;
        }
        start(async () => {
          const response = await fetch(
            `${apiBase()}/api/v1/providers/${encodeURIComponent(provider.id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ usageRates: currency ? next : null }),
            },
          );
          if (!response.ok) {
            const message = await apiErrorMessage(response);
            setError(message);
            showToast(message, { variant: "destructive" });
            return;
          }
          setError(null);
          setCleared(false);
          router.refresh();
        });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Optional operator-configured rates in integer micros. Auto Harness never fetches vendor
        prices.
      </p>
      <p
        className={error ? "text-sm text-red-700" : "hidden"}
        role={error ? "alert" : undefined}
        data-pw="provider-usage-rates-error"
      >
        {error}
      </p>
      <div className="space-y-1">
        <Label htmlFor="usage-rates-currency" tip="ISO 4217 currency such as USD">
          Currency
        </Label>
        <Input
          id="usage-rates-currency"
          name="currency"
          defaultValue={rates?.currency ?? ""}
          placeholder="USD"
          maxLength={3}
          data-pw="provider-usage-rates-currency"
        />
      </div>
      {RATE_FIELDS.map(([key, label]) => (
        <div key={key} className="space-y-1">
          <Label htmlFor={`usage-rates-${key}`}>{label}</Label>
          <Input
            id={`usage-rates-${key}`}
            name={key}
            defaultValue={rates?.[key] ?? ""}
            inputMode="numeric"
            data-pw={`provider-usage-rates-${key}`}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending} data-pw="provider-usage-rates-submit">
          {pending ? "Saving…" : "Save usage rates"}
        </Button>
        <ClearRatesButton
          providerId={provider.id}
          pending={pending}
          start={start}
          onError={setError}
          onCleared={() => {
            setCleared(true);
            setFormKey((key) => key + 1);
          }}
        />
      </div>
    </form>
  );
}

function ClearRatesButton({
  providerId,
  pending,
  start,
  onError,
  onCleared,
}: {
  providerId: string;
  pending: boolean;
  start: ReturnType<typeof useTransition>[1];
  onError: (message: string | null) => void;
  onCleared: () => void;
}) {
  const router = useRouter();
  const [clearing, setClearing] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending || clearing}
      data-pw="provider-usage-rates-clear"
      onClick={() => {
        setClearing(true);
        start(async () => {
          const response = await fetch(
            `${apiBase()}/api/v1/providers/${encodeURIComponent(providerId)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ usageRates: null }),
            },
          );
          setClearing(false);
          if (!response.ok) {
            const message = await apiErrorMessage(response);
            onError(message);
            showToast(message, { variant: "destructive" });
            return;
          }
          onError(null);
          onCleared();
          router.refresh();
        });
      }}
    >
      Clear rates
    </Button>
  );
}

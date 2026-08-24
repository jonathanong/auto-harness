import type { Provider } from "@auto-harness/shared";

import { DeleteProviderButton } from "./delete-provider-button.tsx";
import { EditProviderForm } from "./edit-provider-form.tsx";
import { ProviderUsageRatesForm } from "./provider-usage-rates-form.tsx";

type ProviderSettingsPanelProps = Readonly<{
  accountCount: number;
  commandCount: number;
  provider: Provider;
}>;

export function ProviderSettingsPanel({
  accountCount,
  commandCount,
  provider,
}: ProviderSettingsPanelProps) {
  return (
    <div className="space-y-4" data-pw="provider-settings">
      <p className="font-mono text-xs text-muted-foreground">id: {provider.id}</p>
      <ProviderUsageRatesForm provider={provider} />
      <div className="flex flex-wrap gap-2">
        <EditProviderForm provider={provider} />
        <DeleteProviderButton
          accountCount={accountCount}
          commandCount={commandCount}
          providerId={provider.id}
        />
      </div>
    </div>
  );
}

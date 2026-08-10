/**
 * Compact, read-only health summary for a provider account.
 *
 * The account cooldown is global, so every UI surface that shows an account
 * should use the same "active pause" calculation. An old/expired timestamp is
 * not a paused account.
 */
export function ProviderAccountHealth({
  usageLimitedUntil,
  usageLimitCooldownSeconds,
  lastUsageLimitedAt,
  pw,
}: {
  usageLimitedUntil?: string | null;
  usageLimitCooldownSeconds?: number | null;
  lastUsageLimitedAt?: string | null;
  pw?: string;
}) {
  const paused = isProviderAccountPaused(usageLimitedUntil);
  return (
    <div className="space-y-1 text-xs" data-pw={pw}>
      <div className={paused ? "font-medium text-amber-700" : "text-muted-foreground"}>
        {paused ? `Paused until ${usageLimitedUntil}` : "Available"}
      </div>
      {usageLimitCooldownSeconds != null ? (
        <div className="text-muted-foreground">
          Cooldown: {usageLimitCooldownSeconds}s
          {lastUsageLimitedAt ? ` · last limit ${lastUsageLimitedAt}` : ""}
        </div>
      ) : null}
    </div>
  );
}

export function isProviderAccountPaused(usageLimitedUntil?: string | null): boolean {
  return usageLimitedUntil != null && Date.parse(usageLimitedUntil) > Date.now();
}

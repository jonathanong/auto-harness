import type { ReactNode } from "react";
import Link from "next/link";

export type TabDef = {
  key: string;
  label: string;
  content: ReactNode;
};

export type TabsProps = {
  tabs: TabDef[];
  /** Active tab key from the URL; falls back to the first tab when absent/unknown. */
  active: string;
  /** Base path for tab links (`?tab=key`) — plain navigation, no client JS. */
  basePath: string;
  pw?: string;
};

/** URL-linked tabs (`?tab=key`), first tab is the link-free default. */
export function Tabs({ tabs, active, basePath, pw }: TabsProps) {
  const firstKey = tabs[0]?.key;
  const activeKey = tabs.some((t) => t.key === active) ? active : firstKey;

  return (
    <div data-pw={pw}>
      <div className="flex gap-4 border-b border-border" role="tablist">
        {tabs.map((t) => {
          const isActive = t.key === activeKey;
          const href = t.key === firstKey ? basePath : `${basePath}?tab=${t.key}`;
          return (
            <Link
              key={t.key}
              href={href}
              role="tab"
              aria-selected={isActive}
              data-pw={`tab-${t.key}`}
              className={`-mb-px border-b-2 px-1 py-2 text-sm ${
                isActive
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
      <div className="pt-4">{tabs.find((t) => t.key === activeKey)?.content}</div>
    </div>
  );
}

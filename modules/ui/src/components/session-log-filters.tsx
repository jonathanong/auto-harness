import type { LogCategory } from "../lib/session-log-classify.ts";
import { toggleSetValue } from "../lib/session-log-records.ts";
import { Button } from "./button.tsx";

export function SessionLogFilters({
  categories,
  selected,
  onChange,
}: {
  categories: LogCategory[];
  selected: ReadonlySet<LogCategory>;
  onChange: (next: Set<LogCategory>) => void;
}) {
  if (categories.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-pw="session-log-filters">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={selected.size === 0}
        data-pw="session-log-filter-all"
        onClick={() => onChange(new Set())}
      >
        All
      </Button>
      {categories.map((category) => (
        <Button
          key={category}
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={selected.has(category)}
          data-pw={`session-log-filter-${category}`}
          onClick={() => onChange(toggleSetValue(selected, category))}
        >
          {category}
        </Button>
      ))}
    </div>
  );
}

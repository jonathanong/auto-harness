/** Catalog-backed controls shared by session list surfaces. */
import { Label } from "./label.tsx";

type Option = { id: string; label: string };

function FilterSelect({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`session-filter-${name}`} tip={`Filter sessions by ${label.toLowerCase()}`}>
        {label}
      </Label>
      <select
        id={`session-filter-${name}`}
        data-pw={`session-filter-${name}`}
        className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SessionCatalogFilters({
  repositoryId,
  hostId,
  source,
  repositories,
  hosts,
  onChange,
}: {
  repositoryId: string;
  hostId: string;
  source: string;
  repositories?: Option[];
  hosts?: Option[];
  onChange: (next: { repositoryId?: string; hostId?: string; source?: string }) => void;
}) {
  return (
    <>
      {repositories ? (
        <FilterSelect
          name="repository"
          label="Repository"
          value={repositoryId}
          options={repositories}
          onChange={(value) => onChange({ repositoryId: value })}
        />
      ) : null}
      {hosts ? (
        <FilterSelect
          name="agent"
          label="Agent"
          value={hostId}
          options={hosts}
          onChange={(value) => onChange({ hostId: value })}
        />
      ) : null}
      <FilterSelect
        name="source"
        label="Source"
        value={source}
        options={["api", "ui", "schedule", "webhook"].map((id) => ({ id, label: id }))}
        onChange={(value) => onChange({ source: value })}
      />
    </>
  );
}

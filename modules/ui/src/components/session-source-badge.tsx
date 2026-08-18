import { Badge } from "./badge.tsx";

const knownSources = new Set(["api", "ui", "webhook", "schedule"]);

export function SessionSourceBadge({ source }: { source?: string | null | undefined }) {
  const label = source && knownSources.has(source) ? source : "unknown";
  return (
    <Badge
      variant={label === "unknown" ? "secondary" : "outline"}
      data-pw={`session-source-${label}`}
    >
      {label}
    </Badge>
  );
}

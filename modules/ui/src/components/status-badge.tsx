import { Badge } from "./badge.tsx";

const MAP: Record<string, "default" | "secondary" | "success" | "warning" | "danger" | "outline"> =
  {
    queued: "warning",
    running: "default",
    completed: "success",
    failed: "danger",
    cancelled: "secondary",
    timed_out: "warning",
    true: "success",
    false: "secondary",
  };

export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase();
  const variant = MAP[key] ?? "outline";
  const running = key === "running";
  return (
    <Badge
      variant={variant}
      role={running ? "status" : undefined}
      aria-label={running ? "running, live" : undefined}
      data-pw={running ? "status-running-live" : undefined}
    >
      {running ? (
        <span
          className="mr-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : null}
      {status}
    </Badge>
  );
}

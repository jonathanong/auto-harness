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
  return <Badge variant={variant}>{status}</Badge>;
}

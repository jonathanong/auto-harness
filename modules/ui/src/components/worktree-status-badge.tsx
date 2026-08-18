import { Badge, type BadgeProps } from "./badge.tsx";

const MAP: Record<string, NonNullable<BadgeProps["variant"]>> = {
  // Idle is a worktree's normal resting state, not an achievement — grey reads as
  // "nothing happening" here, matching how `cancelled` already uses it for sessions.
  idle: "secondary",
  busy: "info",
  error: "danger",
};

export function WorktreeStatusBadge({ status }: { status: string }) {
  const variant = MAP[status.toLowerCase()] ?? "outline";
  return <Badge variant={variant}>{status}</Badge>;
}

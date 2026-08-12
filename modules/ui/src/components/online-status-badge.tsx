import { Badge } from "./badge.tsx";

export type OnlineStatusBadgeProps = {
  online: boolean;
  pw?: string;
};

/** Human-readable connection state for hosts and worktrees. */
export function OnlineStatusBadge({ online, pw }: OnlineStatusBadgeProps) {
  return (
    <Badge variant={online ? "success" : "secondary"} data-pw={pw}>
      {online ? "Online" : "Offline"}
    </Badge>
  );
}

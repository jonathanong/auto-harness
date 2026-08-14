import { Badge } from "./badge.tsx";

export function SessionExitCode({ exitCode }: { exitCode?: number | null }) {
  if (exitCode === null || exitCode === undefined) {
    return <span data-pw="session-detail-exit-code">—</span>;
  }
  const success = exitCode === 0;
  return (
    <Badge
      variant={success ? "success" : "danger"}
      data-pw="session-detail-exit-code"
      aria-label={success ? "Exit code 0, success" : `Exit code ${exitCode}, failure`}
    >
      {exitCode}
    </Badge>
  );
}

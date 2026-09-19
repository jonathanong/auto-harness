/**
 * One-line human summary shared by `session create --wait`, `session get`, and `session cancel`:
 * id, status, and (only when present) exit code, error code, and error message. Session records
 * use `errorCode`/`errorMessage` (never `error`) and have no top-level `summary` — see
 * `SessionRecord` in services/api/src/db/types.ts.
 */
export function formatSessionLine(session) {
  const parts = [session.id, session.status];
  if (session.exitCode !== undefined && session.exitCode !== null) {
    parts.push(`exitCode=${session.exitCode}`);
  }
  if (session.errorCode !== undefined) parts.push(`errorCode=${session.errorCode}`);
  if (session.errorMessage !== undefined) parts.push(`errorMessage=${session.errorMessage}`);
  return `${parts.join("  ")}\n`;
}

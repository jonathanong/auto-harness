export function sessionPrincipalId(session: {
  principalId?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  return (
    session.principalId ??
    (typeof session.metadata?.createdBy === "string" ? session.metadata.createdBy : undefined)
  );
}

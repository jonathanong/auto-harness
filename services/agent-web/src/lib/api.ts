import { LOCAL_AGENT_ID } from "@auto-harness/shared";

export { apiBase, apiGet } from "@auto-harness/shared";

export function hostId(): string {
  return (
    process.env.HARNESS_AGENT_ID?.trim() ||
    process.env.NEXT_PUBLIC_HARNESS_AGENT_ID?.trim() ||
    LOCAL_AGENT_ID
  );
}

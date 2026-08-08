import { LOCAL_HOST_ID } from "@auto-harness/shared";

export { apiBase, apiGet } from "@auto-harness/shared";

export function hostId(): string {
  return (
    process.env.HARNESS_HOST_ID?.trim() ||
    process.env.NEXT_PUBLIC_HARNESS_HOST_ID?.trim() ||
    LOCAL_HOST_ID
  );
}

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export async function rollbackProviderAfterCommandFailure(
  providerName: string,
  providerId: string,
  commandResponse: Response,
): Promise<string> {
  const commandError = await apiErrorMessage(commandResponse);
  try {
    const rollbackResponse = await fetch(
      `${apiBase()}/api/v1/providers/${encodeURIComponent(providerId)}`,
      { method: "DELETE" },
    );
    if (rollbackResponse.ok) {
      return `provider "${providerName}" was rolled back because its default command failed: ${commandError}`;
    }
    return `provider "${providerName}" created, but its default command failed: ${commandError}; rollback failed: ${await apiErrorMessage(rollbackResponse)}`;
  } catch (error) {
    return `provider "${providerName}" created, but its default command failed: ${commandError}; rollback failed: ${String(error)}`;
  }
}

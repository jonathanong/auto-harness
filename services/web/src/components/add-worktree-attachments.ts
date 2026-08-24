import type { HostRepository } from "@auto-harness/shared";

export type WorktreeHostAttachment = {
  hostId: string;
  repo: HostRepository;
  hasHostSetupScript?: boolean;
};

export function attachmentsForRepo(
  inventories: Array<{ hostId: string; setupScript?: string; repositories?: HostRepository[] }>,
  repositoryId: string,
): WorktreeHostAttachment[] {
  const attachments: WorktreeHostAttachment[] = [];
  for (const inventory of inventories) {
    const repo = (inventory.repositories ?? []).find((entry) => entry.id === repositoryId);
    if (repo) {
      attachments.push({
        hostId: inventory.hostId,
        repo,
        ...((inventory.setupScript ?? "") !== "" ? { hasHostSetupScript: true } : {}),
      });
    }
  }
  return attachments;
}

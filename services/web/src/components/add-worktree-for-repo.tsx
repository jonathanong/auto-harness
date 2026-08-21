"use client";

import { useState } from "react";
import Link from "next/link";
import { AddWorktreeForm } from "@auto-harness/ui";

import { type WorktreeHostAttachment, attachmentsForRepo } from "./add-worktree-attachments.ts";

export { attachmentsForRepo, type WorktreeHostAttachment };

/** Add-worktree dialog for fleet/repo views, with a host picker when the repo is on several hosts. */
export function AddWorktreeForRepo({
  repositoryId,
  repositoryName,
  attachments,
}: {
  repositoryId: string;
  repositoryName: string;
  attachments: WorktreeHostAttachment[];
}) {
  const [hostId, setHostId] = useState(attachments[0]?.hostId ?? "");
  if (attachments.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-pw={`add-worktree-need-host-${repositoryId}`}
      >
        Attach this repository to a host on the{" "}
        <Link href="/hosts" className="underline">
          Hosts page
        </Link>{" "}
        first.
      </p>
    );
  }
  const selected = attachments.reduce(
    (current, attachment) => (attachment.hostId === hostId ? attachment : current),
    attachments[0]!,
  );
  return (
    <div
      className="flex flex-wrap items-end gap-2"
      data-pw={`add-worktree-for-repo-${repositoryId}`}
    >
      {attachments.length > 1 ? (
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">Host</span>
          <select
            value={selected.hostId}
            onChange={(event) => setHostId(event.currentTarget.value)}
            className="flex h-8 rounded-md border border-border bg-background px-2 text-sm"
            data-pw={`add-worktree-host-${repositoryId}`}
          >
            {attachments.map((attachment) => (
              <option key={attachment.hostId} value={attachment.hostId}>
                {attachment.hostId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <AddWorktreeForm
        key={selected.hostId}
        hostId={selected.hostId}
        repo={selected.repo}
        repoName={repositoryName}
      />
    </div>
  );
}

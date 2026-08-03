"use client";

import type { HostInventory } from "@auto-harness/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@auto-harness/ui";

import { AddRepoForm } from "./host-inventory-add-repo.tsx";

export function AddRepoDialog({
  agentId,
  inventory,
}: {
  agentId: string;
  inventory: HostInventory;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" data-pw="add-repo-open">
          Add repository
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="add-repo-dialog">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Registers the catalog entry and host path only. Add worktrees for this repo on the
            Worktrees page.
          </DialogDescription>
        </DialogHeader>
        <AddRepoForm agentId={agentId} inventory={inventory} />
      </DialogContent>
    </Dialog>
  );
}

"use client";

import type { HostInventory } from "@auto-harness/shared";
import {
  AddRepoForm,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  type RepoCatalogEntry,
} from "@auto-harness/ui";

export function AddRepoDialog({
  hostId,
  inventory,
  catalog,
}: {
  hostId: string;
  inventory: HostInventory;
  catalog: RepoCatalogEntry[];
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
            Attaches an existing catalog repository to this host's local path. To register a new
            repository, use the control plane's Repositories page first.
          </DialogDescription>
        </DialogHeader>
        <AddRepoForm
          hostId={hostId}
          inventory={inventory}
          catalog={catalog}
          browseEndpoint="/api/browse"
        />
      </DialogContent>
    </Dialog>
  );
}

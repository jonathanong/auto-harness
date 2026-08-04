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

import type { RepoCatalogEntry } from "../lib/inventory.ts";
import { AddRepoForm } from "./host-inventory-add-repo.tsx";

export function AddRepoDialog({
  agentId,
  inventory,
  catalog,
}: {
  agentId: string;
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
        <AddRepoForm agentId={agentId} inventory={inventory} catalog={catalog} />
      </DialogContent>
    </Dialog>
  );
}

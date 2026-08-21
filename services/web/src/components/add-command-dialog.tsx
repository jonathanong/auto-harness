"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@auto-harness/ui";
import type { Provider } from "@auto-harness/shared";

import { CommandCreateForm } from "./command-create-form.tsx";

export function AddCommandDialog({
  providers,
  fixedProviderId,
}: {
  providers?: Provider[];
  /** Pins the new command to this provider (provider Commands tab). */
  fixedProviderId?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" data-pw="add-command-open">
          Add command
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="add-command-dialog">
        <DialogHeader>
          <DialogTitle>Add command</DialogTitle>
          <DialogDescription>
            {fixedProviderId
              ? "A fixed argv owned by this provider. The new command stays on this page so you can set it as default."
              : "A fixed argv, optionally owned by a provider. Standalone commands (no provider) run ungated on any worktree."}
          </DialogDescription>
        </DialogHeader>
        <CommandCreateForm providers={providers} fixedProviderId={fixedProviderId} />
      </DialogContent>
    </Dialog>
  );
}

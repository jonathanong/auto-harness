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

import { ProviderCreateForm } from "./provider-create-form.tsx";

export function AddProviderDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" data-pw="add-provider-open">
          Add provider
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="add-provider-dialog">
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            Registers a provider (e.g. claude, codex) and its default command together, so it can
            resolve a command for any account right away.
          </DialogDescription>
        </DialogHeader>
        <ProviderCreateForm />
      </DialogContent>
    </Dialog>
  );
}

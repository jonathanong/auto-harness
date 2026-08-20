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

import { RepoCreateForm } from "./repo-create-form.tsx";

export function AddRepoDialog({
  triggerLabel = "Add repository",
  triggerPw = "add-repo-open",
  dialogPw = "add-repo-dialog",
}: {
  triggerLabel?: string;
  triggerPw?: string;
  dialogPw?: string;
} = {}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" data-pw={triggerPw}>
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent data-pw={dialogPw}>
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Registers a repository in the control-plane catalog only. Attach a local path to a host
            separately, below.
          </DialogDescription>
        </DialogHeader>
        <RepoCreateForm />
      </DialogContent>
    </Dialog>
  );
}

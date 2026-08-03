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

export function AddRepoDialog() {
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
            Registers a repository in the control-plane catalog only. Attach a local host path to an
            agent separately, below.
          </DialogDescription>
        </DialogHeader>
        <RepoCreateForm />
      </DialogContent>
    </Dialog>
  );
}

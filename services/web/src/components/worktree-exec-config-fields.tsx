"use client";

import type { HostWorktree } from "@auto-harness/shared";
import { Label, SetupCacheInputsField, Textarea } from "@auto-harness/ui";

export function WorktreeExecConfigFields({
  worktree,
  onSetupScriptChange,
  onSetupCacheInputsChange,
}: {
  worktree: HostWorktree;
  onSetupScriptChange: () => void;
  onSetupCacheInputsChange: () => void;
}) {
  return (
    <>
      <div className="space-y-1">
        <Label
          htmlFor="worktreeSetupScript"
          tip="Optional worktree override; leave blank to inherit repository setup. Requires fleet:exec-config."
        >
          Setup Script
        </Label>
        <Textarea
          id="worktreeSetupScript"
          name="setupScript"
          rows={5}
          defaultValue={worktree.setupScript ?? ""}
          onChange={onSetupScriptChange}
          className="font-mono text-xs"
          data-pw="worktree-edit-setup-script"
        />
      </div>
      <SetupCacheInputsField
        id="worktreeSetupCacheInputs"
        dataPw="worktree-edit-setup-cache-inputs"
        defaultValue={(worktree.setupCacheInputs ?? []).join("\n")}
        onChange={onSetupCacheInputsChange}
      />
    </>
  );
}

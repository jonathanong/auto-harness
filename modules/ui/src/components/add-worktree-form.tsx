"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addHostWorktree,
  defaultWorktreePath,
  mutateInventory,
  newId,
  type HostRepository,
} from "@auto-harness/shared";

import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { PathInput } from "./path-input.tsx";
import { showToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

export function AddWorktreeForm({
  hostId,
  repo,
  repoName,
  browseEndpoint,
  mutate = mutateInventory,
}: {
  hostId: string;
  repo: HostRepository;
  repoName: string;
  /** Filesystem browse endpoint for the path field (host pane only). */
  browseEndpoint?: string | undefined;
  /** Inventory persistence boundary; injectable for in-memory consumers and tests. */
  mutate?: typeof mutateInventory;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  // Tracks whether the user has typed into the path field directly, independent of its current
  // value — comparing the value against a freshly computed suggestion isn't reliable, since a
  // custom path can coincidentally match what the suggestion would be for the current name.
  const [pathEdited, setPathEdited] = useState(false);
  const [labels, setLabels] = useState("echo");

  if (!open) {
    return (
      <WithTooltip tip="Records the name and path on the control plane. Does not mkdir the worktree directory — the daemon runs git worktree add when online.">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-pw={`add-worktree-open-${repo.id}`}
          onClick={() => setOpen(true)}
        >
          + Add worktree
        </Button>
      </WithTooltip>
    );
  }

  return (
    <form
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw={`form-add-worktree-${repo.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        const wtName = name.trim();
        const wtPath = path.trim();
        if (!wtName || !wtPath) {
          showToast("worktree name and absolute path are required", { variant: "destructive" });
          return;
        }
        const id = newId();
        const requestedLabels = labels
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        start(async () => {
          try {
            const r = await mutate(hostId, (current) =>
              addHostWorktree(current, repo.id, {
                id,
                name: wtName,
                path: wtPath,
                labels: requestedLabels,
              }),
            );
            if (!r.ok) {
              showToast(r.error, { variant: "destructive" });
              return;
            }
            setOpen(false);
            setName("");
            setPath("");
            setPathEdited(false);
            router.refresh();
          } catch (err) {
            showToast(err instanceof Error ? err.message : String(err), { variant: "destructive" });
          }
        });
      }}
    >
      <p className="text-sm font-medium">New worktree under {repoName}</p>
      <p className="text-xs text-muted-foreground">
        Records the name and path only. Do not mkdir this directory — the daemon runs{" "}
        <code className="font-mono">git worktree add</code> when online.
      </p>
      <div className="space-y-1">
        <Label tip="Lowercase letters, numbers, and dashes only; unique across all hosts. Id is auto-generated.">
          name
        </Label>
        <Input
          value={name}
          onChange={(e) => {
            const v = e.target.value;
            setName(v);
            if (!path || path === defaultWorktreePath(repo.path, name)) {
              setPath(v.trim() ? defaultWorktreePath(repo.path, v.trim()) : "");
            }
          }}
          required
          placeholder="runner-1"
          data-pw={`add-worktree-name-${repo.id}`}
        />
      </div>
      <div className="space-y-1">
        <Label tip="Absolute path on this host. Do not mkdir it — the daemon git worktree adds when online. Suggested path is optional — edit freely.">
          absolute path
        </Label>
        <PathInput
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setPathEdited(true);
          }}
          onFocus={(e) => {
            // Select the auto-suggested path on focus so typing replaces it outright — without
            // this, typing a different absolute path inserts into the suggestion instead of
            // overwriting it (e.g. producing "/tmp/foo//tmp/bar"). Only while the field still
            // holds the live, un-edited suggestion; once the user has typed into it directly,
            // focusing back in to fix a typo shouldn't wipe out their own text.
            if (path && !pathEdited) e.target.select();
          }}
          required
          placeholder={defaultWorktreePath(repo.path, "my-wt")}
          data-pw={`add-worktree-path-${repo.id}`}
          browseEndpoint={browseEndpoint}
        />
      </div>
      <div className="space-y-1">
        <Label tip="Scheduler labels (e.g. echo) used when matching work to worktrees">
          labels (comma-separated)
        </Label>
        <Input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          data-pw={`add-worktree-labels-${repo.id}`}
        />
      </div>
      <div className="flex gap-2">
        <WithTooltip tip="Persist this worktree on host inventory (daemon reloads within ~15s)">
          <Button
            type="submit"
            size="sm"
            disabled={pending}
            data-pw={`add-worktree-submit-${repo.id}`}
          >
            {pending ? "Saving…" : "Save worktree"}
          </Button>
        </WithTooltip>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/* eslint-disable max-lines -- profile editing and trusted configuration submit share stable client row identity. */
"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  WithTooltip,
  showToast,
  withToast,
} from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export type WorkspaceSetupProfile = { id: string; name: string; script: string };
export type WorkspacePoolConfig = {
  id: string;
  name: string;
  setupProfiles: WorkspaceSetupProfile[];
  defaultSetupProfileId?: string;
  destroyWorkspaceAfter: boolean;
};

const emptyProfile = (): WorkspaceSetupProfile => ({ id: "", name: "", script: "" });
type ProfileRow = WorkspaceSetupProfile & { key: string };

export function WorkspacePoolForm({ pool }: { pool?: WorkspacePoolConfig }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const profileKey = useRef(0);
  const [profiles, setProfiles] = useState<ProfileRow[]>(() =>
    (pool?.setupProfiles ?? []).map((profile) => ({
      ...profile,
      key: `saved-${profileKey.current++}`,
    })),
  );
  const [defaultProfileId, setDefaultProfileId] = useState(pool?.defaultSetupProfileId ?? "");
  const [destroyWorkspaceAfter, setDestroyWorkspaceAfter] = useState(
    pool?.destroyWorkspaceAfter ?? false,
  );
  const create = pool === undefined;

  const updateProfile = (index: number, field: keyof WorkspaceSetupProfile, value: string) => {
    setProfiles((current) =>
      current.map((profile, candidate) =>
        candidate === index ? { ...profile, [field]: value } : profile,
      ),
    );
  };

  return (
    <form
      className="grid max-w-2xl gap-4"
      data-pw={create ? "form-workspace-pool-create" : "form-workspace-pool-edit"}
      onSubmit={(event) => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
        const body = {
          name,
          setupProfiles: profiles.map((profile) => ({
            id: profile.id.trim(),
            name: profile.name.trim(),
            script: profile.script,
          })),
          defaultSetupProfileId: defaultProfileId || null,
          destroyWorkspaceAfter,
        };
        setPending(true);
        void (async () => {
          const endpoint = pool
            ? `${apiBase()}/api/v1/workspace-pools/${encodeURIComponent(pool.id)}`
            : `${apiBase()}/api/v1/workspace-pools`;
          const response = await fetch(endpoint, {
            method: pool ? "PATCH" : "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            showToast(await apiErrorMessage(response), {
              variant: "destructive",
              pw: "workspace-pool-form-error",
            });
            setPending(false);
            return;
          }
          const saved = (await response.json()) as { id: string };
          setPending(false);
          router.push(
            withToast(`/workspace-pools/${encodeURIComponent(saved.id)}`, "Workspace pool saved."),
          );
          router.refresh();
        })();
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="workspace-pool-name"
          tip="Unique lowercase slug used to route workspace sessions"
        >
          Pool name
        </Label>
        <Input
          id="workspace-pool-name"
          name="name"
          required
          defaultValue={pool?.name}
          placeholder="browser-tests"
          data-pw="workspace-pool-name"
        />
      </div>
      <fieldset className="space-y-3" data-pw="workspace-pool-profiles">
        <legend className="text-sm font-medium">Trusted setup profiles</legend>
        <p className="text-xs text-muted-foreground">
          Scripts are stored on this admin configuration surface and are selected by profile ID at
          session creation. They are never entered on an execution form.
        </p>
        {profiles.map((profile, index) => (
          <div key={profile.key} className="grid gap-2 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-2">
              <Input
                aria-label={`Setup profile ${index + 1} ID`}
                value={profile.id}
                onChange={(event) => updateProfile(index, "id", event.currentTarget.value)}
                placeholder="install-deps"
                data-pw={`workspace-pool-profile-id-${index}`}
              />
              <Input
                aria-label={`Setup profile ${index + 1} name`}
                value={profile.name}
                onChange={(event) => updateProfile(index, "name", event.currentTarget.value)}
                placeholder="Install dependencies"
                data-pw={`workspace-pool-profile-name-${index}`}
              />
            </div>
            <Textarea
              aria-label={`Setup profile ${index + 1} script`}
              value={profile.script}
              onChange={(event) => updateProfile(index, "script", event.currentTarget.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder="pnpm install --frozen-lockfile"
              data-pw={`workspace-pool-profile-script-${index}`}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setProfiles((current) => current.filter((_, candidate) => candidate !== index));
                if (defaultProfileId === profile.id) setDefaultProfileId("");
              }}
              data-pw={`workspace-pool-profile-remove-${index}`}
            >
              Remove profile
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            setProfiles((current) => [
              ...current,
              { ...emptyProfile(), key: `new-${profileKey.current++}` },
            ])
          }
          data-pw="workspace-pool-profile-add"
        >
          Add setup profile
        </Button>
      </fieldset>
      <div className="space-y-1">
        <Label
          htmlFor="workspace-pool-default-profile"
          tip="Used when a workspace session does not select a profile"
        >
          Default setup profile
        </Label>
        <select
          id="workspace-pool-default-profile"
          value={defaultProfileId}
          onChange={(event) => setDefaultProfileId(event.currentTarget.value)}
          data-pw="workspace-pool-default-profile"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
        >
          <option value="">No default profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name || profile.id || "Unnamed profile"}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={destroyWorkspaceAfter}
          onChange={(event) => setDestroyWorkspaceAfter(event.currentTarget.checked)}
          data-pw="workspace-pool-destroy-after"
        />
        Destroy and recreate the workspace after each session by default
      </label>
      <WithTooltip
        tip={create ? "Create this workspace pool" : "Save workspace-pool configuration"}
      >
        <Button type="submit" disabled={pending} data-pw="workspace-pool-submit">
          {pending ? "Saving…" : create ? "Create workspace pool" : "Save workspace pool"}
        </Button>
      </WithTooltip>
    </form>
  );
}

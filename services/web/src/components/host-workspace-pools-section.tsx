/* eslint-disable max-lines -- slot mutations preserve one host-inventory document. */
"use client";

import { useState } from "react";
import { Button, Input, WithTooltip, showToast } from "@auto-harness/ui";
import { mutateInventory } from "@auto-harness/shared";
import type { HostInventory } from "@auto-harness/shared";

import { navigateBrowser } from "../lib/browser-navigation.ts";

type Pool = { id: string; name: string };

export function HostWorkspacePoolsSection({
  hostId,
  inventory,
  pools,
  canWriteExecConfig,
}: {
  hostId: string;
  inventory: HostInventory;
  pools: Pool[];
  canWriteExecConfig: boolean;
}) {
  const [pending, setPending] = useState(false);
  const save = (mutate: (current: HostInventory) => HostInventory) => {
    setPending(true);
    void (async () => {
      try {
        const result = await mutateInventory(hostId, mutate);
        if (!result.ok)
          showToast(result.error, { variant: "destructive", pw: "host-workspace-pools-error" });
        else navigateBrowser(`${location.pathname}${location.search}`);
      } catch (error) {
        showToast(String(error), { variant: "destructive", pw: "host-workspace-pools-error" });
      } finally {
        setPending(false);
      }
    })();
  };
  const attachments = inventory.workspacePools ?? [];
  return (
    <div className="space-y-4" data-pw="host-workspace-pools">
      <div>
        <h3 className="text-lg font-medium">Workspace pools</h3>
        <p className="text-sm text-muted-foreground">
          Host-local non-git slots. Paths must be absolute and under this host&apos;s allowed roots.
        </p>
      </div>
      {attachments.map((attachment) => (
        <section
          key={attachment.workspacePoolId}
          className="space-y-2 rounded-md border p-3"
          data-pw={`host-workspace-pool-${attachment.workspacePoolId}`}
        >
          <div className="flex items-center justify-between">
            <strong>
              {pools.find((pool) => pool.id === attachment.workspacePoolId)?.name ??
                attachment.workspacePoolId}
            </strong>
            {canWriteExecConfig ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  save((current) => ({
                    ...current,
                    workspacePools: (current.workspacePools ?? []).filter(
                      (pool) => pool.workspacePoolId !== attachment.workspacePoolId,
                    ),
                  }))
                }
              >
                Remove pool
              </Button>
            ) : null}
          </div>
          {attachment.slots.map((slot) => (
            <form
              key={slot.id}
              className="grid grid-cols-4 gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                save((current) => ({
                  ...current,
                  workspacePools: (current.workspacePools ?? []).map((pool) =>
                    pool.workspacePoolId === attachment.workspacePoolId
                      ? {
                          ...pool,
                          slots: pool.slots.map((candidate) =>
                            candidate.id === slot.id
                              ? {
                                  id: String(data.get("id") ?? ""),
                                  name: String(data.get("name") ?? ""),
                                  path: String(data.get("path") ?? ""),
                                }
                              : candidate,
                          ),
                        }
                      : pool,
                  ),
                }));
              }}
            >
              <Input name="id" defaultValue={slot.id} aria-label="Slot id" />
              <Input name="name" defaultValue={slot.name} aria-label="Slot name" />
              <Input name="path" defaultValue={slot.path} aria-label="Slot path" />
              <div className="flex gap-1">
                {canWriteExecConfig ? (
                  <Button size="sm" disabled={pending}>
                    Save
                  </Button>
                ) : null}
                {canWriteExecConfig ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      save((current) => ({
                        ...current,
                        workspacePools: (current.workspacePools ?? []).map((pool) =>
                          pool.workspacePoolId === attachment.workspacePoolId
                            ? {
                                ...pool,
                                slots: pool.slots.filter((candidate) => candidate.id !== slot.id),
                              }
                            : pool,
                        ),
                      }))
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </form>
          ))}
        </section>
      ))}
      {canWriteExecConfig ? (
        <form
          className="grid grid-cols-4 gap-2 border-t pt-4"
          data-pw="host-workspace-slot-add"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const poolId = String(data.get("poolId") ?? "");
            const slot = {
              id: String(data.get("id") ?? ""),
              name: String(data.get("name") ?? ""),
              path: String(data.get("path") ?? ""),
            };
            save((current) => {
              const existing = current.workspacePools ?? [];
              const found = existing.find((pool) => pool.workspacePoolId === poolId);
              return {
                ...current,
                workspacePools: found
                  ? existing.map((pool) =>
                      pool.workspacePoolId === poolId
                        ? { ...pool, slots: [...pool.slots, slot] }
                        : pool,
                    )
                  : [...existing, { workspacePoolId: poolId, slots: [slot] }],
              };
            });
          }}
        >
          <select
            name="poolId"
            required
            data-pw="host-workspace-pool-select"
            className="h-9 rounded-md border bg-background px-2"
          >
            {pools.map((pool) => (
              <option key={pool.id} value={pool.id}>
                {pool.name}
              </option>
            ))}
          </select>
          <Input name="id" required placeholder="slot id" data-pw="host-workspace-slot-id" />
          <Input name="name" required placeholder="slot name" data-pw="host-workspace-slot-name" />
          <Input
            name="path"
            required
            placeholder="/absolute/path"
            data-pw="host-workspace-slot-path"
          />
          <WithTooltip tip="Attach a host-local workspace slot">
            <Button
              type="submit"
              disabled={pending || pools.length === 0}
              data-pw="host-workspace-slot-add-submit"
            >
              Add slot
            </Button>
          </WithTooltip>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Workspace-slot changes require <code>fleet:exec-config</code>.
        </p>
      )}
    </div>
  );
}

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { mutateInventory } from "@auto-harness/shared";
import { AddRepoForm, withToast, type RepoCatalogEntry } from "@auto-harness/ui";

/**
 * `AddRepoForm`'s own default success navigation goes to the repository's catalog page —
 * right for a standalone repo-attach flow, wrong here: this renders inside a host's own
 * Repositories & Worktrees tab, where the natural next step (add a worktree, attach a
 * provider account) is on the same page. Stay put and refresh instead of jumping away.
 */
export function HostAddRepoForm({
  hostId,
  catalog,
  mutate = mutateInventory,
}: {
  hostId: string;
  catalog: RepoCatalogEntry[];
  /** Inventory persistence boundary; injectable for tests. */
  mutate?: typeof mutateInventory;
}) {
  const router = useRouter();
  // Both hooks type as non-nullable in real Next.js, but a route context-free render (this
  // component's own unit test's server-render harness, notably) genuinely returns null at
  // runtime — guard rather than trust the type.
  const pathname = usePathname() ?? "/";
  const search = useSearchParams()?.toString();
  return (
    <AddRepoForm
      hostId={hostId}
      catalog={catalog}
      mutate={mutate}
      onSuccess={() => {
        router.push(
          withToast(
            search ? `${pathname}?${search}` : pathname,
            "Repository attached with no worktrees.",
          ),
        );
      }}
    />
  );
}

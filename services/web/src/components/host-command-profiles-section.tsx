import type { HostInventory } from "@auto-harness/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@auto-harness/ui";

import { CommandProfileForm } from "./command-profile-form.tsx";
import { RemoveCommandProfileButton } from "./remove-command-profile-button.tsx";

export function HostCommandProfilesSection({
  agentId,
  inventory,
}: {
  agentId: string;
  inventory: HostInventory;
}) {
  const names = Object.keys(inventory.commandProfiles).toSorted();
  return (
    <div className="space-y-4" data-pw="host-command-profiles-section">
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">No command profiles yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>name</TableHead>
              <TableHead>argv</TableHead>
              <TableHead>append prompt</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((name) => {
              const profile = inventory.commandProfiles[name]!;
              return (
                <TableRow key={name} data-pw={`profile-row-${name}`}>
                  <TableCell className="font-mono text-xs">{name}</TableCell>
                  <TableCell className="font-mono text-xs">{profile.argv.join(" ")}</TableCell>
                  <TableCell>{String(profile.appendPrompt)}</TableCell>
                  <TableCell className="text-right">
                    <RemoveCommandProfileButton
                      agentId={agentId}
                      inventory={inventory}
                      name={name}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <CommandProfileForm agentId={agentId} inventory={inventory} />
    </div>
  );
}

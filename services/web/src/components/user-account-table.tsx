"use client";

import {
  ConfirmButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import type { UserAccount } from "./user-account-api.ts";

export function UserAccountTable({
  accounts,
  onDelete,
}: {
  accounts: UserAccount[];
  onDelete: (username: string) => Promise<void>;
}) {
  if (!accounts.length) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="user-accounts-empty">
        No user accounts yet.
      </p>
    );
  }
  return (
    <Table data-pw="user-accounts-table">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Username</TableHead>
          <TableHead scope="col">Role</TableHead>
          <TableHead scope="col" className="text-right">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <TableRow key={account.id} data-pw={`user-account-row-${account.username}`}>
            <TableCell className="font-medium">{account.username}</TableCell>
            <TableCell>{account.role}</TableCell>
            <TableCell className="text-right">
              <ConfirmButton
                triggerLabel="Delete"
                confirmTitle={`Delete ${account.username}?`}
                confirmDescription="This removes the user's account and cannot be undone."
                confirmLabel="Delete account"
                variant="destructive"
                pw={`user-account-delete-${account.username}`}
                onConfirm={async () => {
                  try {
                    await onDelete(account.username);
                  } catch (cause) {
                    return {
                      ok: false,
                      error:
                        cause instanceof Error ? cause.message : "Unable to delete user account.",
                    };
                  }
                }}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

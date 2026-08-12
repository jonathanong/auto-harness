"use client";

import { useState } from "react";
import {
  Button,
  ConfirmButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@auto-harness/ui";

import type { RepositoryOption, ServiceAccount } from "./service-account-api.ts";

export function ServiceAccountTable({
  accounts,
  repositories,
  onRotate,
  onDelete,
}: {
  accounts: ServiceAccount[];
  repositories: RepositoryOption[];
  onRotate: (account: ServiceAccount) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [rotatingId, setRotatingId] = useState<string>();
  const [rotationError, setRotationError] = useState<{ id: string; message: string }>();
  const repositoryNames = new Map(
    repositories.map((repository) => [repository.id, repository.name]),
  );
  if (!accounts.length) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="service-accounts-empty">
        No service accounts yet.
      </p>
    );
  }
  return (
    <Table data-pw="service-accounts-table">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Name</TableHead>
          <TableHead scope="col">Role</TableHead>
          <TableHead scope="col">Scope</TableHead>
          <TableHead scope="col">Created</TableHead>
          <TableHead scope="col" className="text-right">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <TableRow key={account.id} data-pw={`service-account-row-${account.id}`}>
            <TableCell>
              <span className="font-medium">{account.name}</span>
              {account.boundHostId ? (
                <span className="block text-xs text-muted-foreground">
                  Host: {account.boundHostId}
                </span>
              ) : null}
            </TableCell>
            <TableCell>{account.role}</TableCell>
            <TableCell>{repositoryScope(account, repositoryNames)}</TableCell>
            <TableCell>{formatCreatedAt(account.createdAt)}</TableCell>
            <TableCell>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rotatingId !== undefined}
                  data-pw={`service-account-rotate-${account.id}`}
                  onClick={() => {
                    setRotatingId(account.id);
                    setRotationError(undefined);
                    void onRotate(account)
                      .catch((cause) =>
                        setRotationError({
                          id: account.id,
                          message:
                            cause instanceof Error ? cause.message : "Unable to rotate account.",
                        }),
                      )
                      .finally(() => setRotatingId(undefined));
                  }}
                >
                  {rotatingId === account.id ? "Rotating…" : "Rotate"}
                </Button>
                <ConfirmButton
                  triggerLabel="Delete"
                  confirmTitle={`Delete ${account.name}?`}
                  confirmDescription="This immediately revokes the API key and cannot be undone."
                  confirmLabel="Delete account"
                  variant="destructive"
                  pw={`service-account-delete-${account.id}`}
                  onConfirm={async () => {
                    try {
                      await onDelete(account.id);
                    } catch (cause) {
                      return {
                        ok: false,
                        error: cause instanceof Error ? cause.message : "Unable to delete account.",
                      };
                    }
                  }}
                />
              </div>
              {rotationError?.id === account.id ? (
                <p
                  className="mt-2 text-sm text-red-700"
                  role="alert"
                  data-pw={`service-account-rotate-${account.id}-error`}
                >
                  {rotationError.message}
                </p>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toISOString().slice(0, 10);
}

function repositoryScope(account: ServiceAccount, repositoryNames: Map<string, string>): string {
  if (!account.allowedRepositoryIds?.length) return "All repositories";
  return account.allowedRepositoryIds.map((id) => repositoryNames.get(id) ?? id).join(", ");
}

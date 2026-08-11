import { ConfirmButton } from "@auto-harness/ui";

export function SlackDeleteSection({
  pending,
  onConfirm,
}: {
  pending: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <div className="border-t border-border pt-4">
      <h4 className="font-medium">Remove configuration</h4>
      <p className="mt-1 text-sm text-muted-foreground">
        This permanently removes the stored Slack configuration. It cannot be undone.
      </p>
      <ConfirmButton
        triggerLabel="Delete Slack configuration"
        confirmTitle="Delete Slack configuration?"
        confirmDescription="This permanently removes the encrypted bot token and all notification settings. Confirm only if you intend to disable this integration."
        confirmLabel="Delete configuration"
        variant="destructive"
        pw="slack-delete"
        disabled={pending}
        onConfirm={onConfirm}
      />
    </div>
  );
}

import { Alert } from "@auto-harness/ui";

export function ProviderAccountUnattachedWarning({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const listed = labels.join(", ");
  return (
    <Alert variant="warning" role="note" data-pw="provider-account-unattached-warning">
      {labels.length === 1
        ? `${listed} is not attached to any host.`
        : `${listed} are not attached to any host.`}{" "}
      Attach {labels.length === 1 ? "it" : "them"} from a host so sessions targeting this provider
      can run.
    </Alert>
  );
}

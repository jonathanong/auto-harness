import { Card, CardContent, CardHeader, CardTitle, TipText } from "@auto-harness/ui";

export function DashboardMetricCard({
  label,
  value,
  detail,
  tip,
  pw,
}: {
  label: string;
  value: string;
  detail?: string;
  tip: string;
  pw: string;
}) {
  return (
    <Card data-pw={pw}>
      <CardHeader>
        <CardTitle className="text-base">
          <TipText tip={tip}>{label}</TipText>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-3xl font-semibold">
        <span data-pw={`${pw}-value`}>{value}</span>
        {detail ? (
          <span
            className="mt-1 block text-xs font-normal text-muted-foreground"
            data-pw={`${pw}-detail`}
          >
            {detail}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}

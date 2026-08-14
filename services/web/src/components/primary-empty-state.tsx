import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@auto-harness/ui";

export function PrimaryEmptyState({
  title,
  children,
  pw,
}: {
  title: string;
  children: ReactNode;
  pw: string;
}) {
  return (
    <Card data-pw={pw}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

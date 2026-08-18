import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Alert } from "./alert.tsx";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { OnlineStatusBadge } from "./online-status-badge.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";
import { Textarea } from "./textarea.tsx";
import { TipLink } from "./tip-link.tsx";
import { TipText } from "./tip-text.tsx";
import { TooltipProvider } from "./tooltip.tsx";
import { cn } from "../lib/utils.ts";

function render(node: ReactNode) {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

describe("shared display primitives", () => {
  it("merges utility classes and renders every badge and button variant", () => {
    expect(cn("px-2", false, "px-4", "font-medium")).toBe("px-4 font-medium");

    for (const variant of [
      "default",
      "secondary",
      "outline",
      "success",
      "warning",
      "danger",
      "info",
    ] as const) {
      const markup = render(
        <Badge variant={variant} className="marker">
          {variant}
        </Badge>,
      );
      expect(markup).toContain(`>${variant}</div>`);
      expect(markup).toContain("marker");
    }

    for (const variant of ["success", "warning", "danger", "info"] as const) {
      const markup = render(
        <Alert variant={variant} role="status" data-pw="alert-marker">
          {variant} message
        </Alert>,
      );
      expect(markup).toContain(`>${variant} message</div>`);
      expect(markup).toContain('role="status"');
      expect(markup).toContain('data-pw="alert-marker"');
    }
    expect(render(<Alert>default variant</Alert>)).toContain("border-info/30");

    for (const variant of ["default", "outline", "ghost", "destructive"] as const) {
      for (const size of ["default", "sm", "lg"] as const) {
        const markup = render(
          <Button
            variant={variant}
            size={size}
            type="submit"
            disabled
            aria-label={`${variant}-${size}`}
          >
            Save
          </Button>,
        );
        expect(markup).toContain("<button");
        expect(markup).toContain('type="submit"');
        expect(markup).toContain('disabled=""');
        expect(markup).toContain(`aria-label="${variant}-${size}"`);
      }
    }
  });

  it("keeps semantic structure, labels, and form attributes intact", () => {
    const card = render(
      <Card className="card-marker" data-pw="summary-card">
        <CardHeader className="header-marker">
          <CardTitle className="title-marker">Summary</CardTitle>
        </CardHeader>
        <CardContent className="content-marker">Details</CardContent>
      </Card>,
    );
    expect(card).toContain('data-pw="summary-card"');
    expect(card).toContain("card-marker");
    expect(card).toContain("header-marker");
    expect(card).toContain(
      '<h3 class="text-lg font-semibold leading-none tracking-tight title-marker">Summary</h3>',
    );
    expect(card).toContain("content-marker");

    const fields = render(
      <>
        <Label htmlFor="title">Title</Label>
        <Label htmlFor="description" tip="Explain the request">
          Description
        </Label>
        <Input
          id="title"
          type="email"
          required
          aria-describedby="title-help"
          className="input-marker"
        />
        <Textarea id="description" rows={4} required className="textarea-marker" />
      </>,
    );
    expect(fields).toContain(
      '<label class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70" for="title">Title</label>',
    );
    expect(fields).toContain('for="description"');
    expect(fields).toContain("cursor-help");
    expect(fields).toContain('id="title"');
    expect(fields).toContain('type="email"');
    expect(fields).toContain('aria-describedby="title-help"');
    expect(fields).toContain('id="description"');
    expect(fields).toContain('rows="4"');
    expect(fields).toContain("input-marker");
    expect(fields).toContain("textarea-marker");
  });

  it("renders accessible table structure and status meanings", () => {
    const table = render(
      <Table className="table-marker" aria-label="Sessions">
        <TableHeader className="header-marker">
          <TableRow className="row-marker">
            <TableHead className="head-marker">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="body-marker">
          <TableRow>
            <TableCell className="cell-marker">Queued</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(table).toContain('<div class="relative w-full overflow-auto"><table');
    expect(table).toContain('aria-label="Sessions"');
    expect(table).toContain("table-marker");
    expect(table).toContain("header-marker");
    expect(table).toContain("row-marker");
    expect(table).toContain("<th");
    expect(table).toContain("head-marker");
    expect(table).toContain("body-marker");
    expect(table).toContain("cell-marker");

    expect(render(<StatusBadge status="QUEUED" />)).toContain("bg-warning/10");
    const running = render(<StatusBadge status="running" />);
    expect(running).toContain("bg-primary");
    expect(running).toContain("animate-pulse");
    expect(running).toContain("motion-reduce:animate-none");
    expect(running).toContain('role="status"');
    expect(running).toContain('aria-label="running, live"');
    expect(running).toContain('data-pw="status-running-live"');
    expect(render(<StatusBadge status="completed" />)).toContain("bg-success/10");
    expect(render(<StatusBadge status="failed" />)).toContain("bg-danger/10");
    expect(render(<StatusBadge status="cancelled" />)).toContain("bg-muted");
    expect(render(<StatusBadge status="unknown" />)).toContain("text-foreground");
    expect(render(<StatusBadge status="unknown" />)).not.toContain("animate-pulse");
    expect(render(<OnlineStatusBadge online pw="host-online-a" />)).toContain(
      'data-pw="host-online-a">Online',
    );
    expect(render(<OnlineStatusBadge online={false} />)).toContain(">Offline</div>");
  });

  it("preserves text and link semantics with tooltip guidance", () => {
    const text = render(
      <TipText as="h2" tip="More detail" className="tip-text" pw="session-title">
        Run
      </TipText>,
    );
    expect(text).toContain('<h2 class="tip-text" data-pw="session-title"');
    expect(text).toContain(">Run</h2>");

    const link = render(
      <TipLink href="/sessions/one" tip="Open the session" className="tip-link" pw="open-session">
        Open
      </TipLink>,
    );
    expect(link).toContain('<a class="tip-link" data-pw="open-session"');
    expect(link).toContain('href="/sessions/one"');
    expect(link).toContain(">Open</a>");
  });
});

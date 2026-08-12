import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Table, TableHead, TableHeader, TableRow } from "./table.tsx";

describe("TableHead accessibility semantics", () => {
  it("defaults to column scope and preserves an explicit scope override", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        Table,
        null,
        React.createElement(
          TableHeader,
          null,
          React.createElement(
            TableRow,
            null,
            React.createElement(TableHead, { children: "Column heading" }),
            React.createElement(TableHead, { scope: "row", children: "Row heading" }),
          ),
        ),
      ),
    );

    expect(markup).toContain(
      '<th class="h-10 px-3 text-left align-middle font-medium text-muted-foreground" scope="col">Column heading</th>',
    );
    expect(markup).toContain(
      '<th class="h-10 px-3 text-left align-middle font-medium text-muted-foreground" scope="row">Row heading</th>',
    );
  });
});

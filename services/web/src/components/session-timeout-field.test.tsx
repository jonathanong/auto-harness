import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionTimeoutField } from "./session-timeout-field.tsx";

describe("SessionTimeoutField", () => {
  it("defaults null values and selects custom non-preset durations", () => {
    expect(renderToStaticMarkup(<SessionTimeoutField initialSeconds={null} />)).toContain(
      'value="600"',
    );
    const custom = renderToStaticMarkup(<SessionTimeoutField initialSeconds={42} />);
    expect(custom).toContain('value="custom" selected=""');
    expect(custom).toContain('value="42"');
    expect(renderToStaticMarkup(<SessionTimeoutField initialSeconds={300} />)).toContain(
      'value="300" selected=""',
    );
  });
});

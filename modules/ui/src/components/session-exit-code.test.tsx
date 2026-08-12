import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionExitCode } from "./session-exit-code.tsx";

describe("SessionExitCode", () => {
  it("renders exit code zero as a successful result", () => {
    const html = renderToStaticMarkup(<SessionExitCode exitCode={0} />);
    expect(html).toContain("Exit code 0, success");
    expect(html).toContain("bg-emerald");
    expect(html).toContain(">0<");
  });

  it.each([1, 127, -1])("renders non-zero exit code %s as a failure", (exitCode) => {
    const html = renderToStaticMarkup(<SessionExitCode exitCode={exitCode} />);
    expect(html).toContain(`Exit code ${exitCode}, failure`);
    expect(html).toContain("bg-red");
  });

  it.each([null, undefined])("renders absent exit code %s as unavailable", (exitCode) => {
    expect(renderToStaticMarkup(<SessionExitCode exitCode={exitCode} />)).toContain("—");
  });
});

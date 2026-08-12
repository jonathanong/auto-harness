import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduleHistoryTime } from "./schedule-history-time.tsx";

describe("ScheduleHistoryTime", () => {
  it.each([
    ["2026-08-12T12:00:00.000Z", "2026-08-12T12:00:42.000Z", "42s"],
    ["2026-08-12T12:00:00.000Z", "2026-08-12T12:02:03.000Z", "2m 3s"],
    ["2026-08-12T12:00:00.000Z", "2026-08-12T14:03:00.000Z", "2h 3m"],
    ["2026-08-12T12:00:42.000Z", "2026-08-12T12:00:00.000Z", "0s"],
  ])("shows %s to %s as %s", (createdAt, completedAt, duration) => {
    const html = renderToStaticMarkup(
      <ScheduleHistoryTime createdAt={createdAt} completedAt={completedAt} sessionId="s/1" />,
    );
    expect(html).toContain(`dateTime="${createdAt}"`);
    expect(html).toContain(duration);
  });

  it("omits duration for active runs and handles absent or invalid creation times", () => {
    const active = renderToStaticMarkup(
      <ScheduleHistoryTime
        createdAt="2026-08-12T12:00:00.000Z"
        completedAt={null}
        sessionId="active"
      />,
    );
    expect(active).not.toContain("schedule-history-duration");
    const missing = renderToStaticMarkup(<ScheduleHistoryTime sessionId="missing" />);
    expect(missing).toContain("—");
    const invalid = renderToStaticMarkup(
      <ScheduleHistoryTime createdAt="invalid" completedAt="also-invalid" sessionId="invalid" />,
    );
    expect(invalid).toContain("—");
  });
});

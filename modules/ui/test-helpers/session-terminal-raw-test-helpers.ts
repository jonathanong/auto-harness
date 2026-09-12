import { act } from "react";

import { field, press } from "./action-form-test-helpers.ts";

export async function settleTerminal(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

export async function openRawTerminal(container: HTMLElement): Promise<void> {
  await settleTerminal();
  if (field(container, "session-terminal").getAttribute("data-view") !== "raw") {
    press(field(container, "session-log-raw"));
    await settleTerminal();
  }
}

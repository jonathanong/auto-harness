/**
 * The one place the e2e port layout is decided.
 *
 * `HARNESS_E2E_PORT_OFFSET` shifted the ports Playwright *starts* servers on, but the
 * specs hard-coded `http://127.0.0.1:7430` in 67 places, so a non-zero offset started the
 * stack on one set of ports and pointed every test at another. Import these instead of
 * writing a literal.
 */

function parsePortOffset(value: string | undefined = process.env.HARNESS_E2E_PORT_OFFSET): number {
  if (value === undefined || value === "") return 0;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > 50_000) {
    throw new Error("HARNESS_E2E_PORT_OFFSET must be an integer from 0 through 50000");
  }
  return offset;
}

const offset = parsePortOffset();

/** Base ports; the +10 offset from the 742x dev range keeps runs off a dev session. */
export const API_PORT = 7430 + offset;
export const CONTROL_PORT = 7431 + offset;
export const HOST_PANE_PORT = 7432 + offset;
const DYNAMO_PORT = 7433 + offset;

export const API_BASE = `http://127.0.0.1:${API_PORT}`;
export const WS_BASE = `ws://127.0.0.1:${API_PORT}/ws`;
export const DYNAMO_ENDPOINT =
  process.env.HARNESS_E2E_DDB_ENDPOINT ?? `http://127.0.0.1:${DYNAMO_PORT}`;

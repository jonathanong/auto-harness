import { CliUsageError } from "./cli-errors.js";

/**
 * Encodes one path segment taken from the command line, such as a host or repository id.
 *
 * `encodeURIComponent` leaves `.` untouched, so an id of `.` or `..` survives encoding and the
 * URL parser then resolves it as a dot segment: `repo rm ..` would send
 * `DELETE /api/v1/repositories/..`, which is `DELETE /api/v1/`. No real id is `.` or `..`, so
 * both are rejected. Percent-encoded dots need no check here: encoding turns `%2e` into `%252e`,
 * which the parser does not treat as a dot segment.
 *
 * Call it as soon as the positional is parsed, before `createClient` — in admin mode that makes
 * a network login, and a bad id should not cost one.
 */
export function pathSegment(value, label) {
  if (value === "." || value === "..") {
    throw new CliUsageError(`${label} must not be "." or ".."`);
  }
  return encodeURIComponent(value);
}

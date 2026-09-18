/** A malformed invocation: a bad flag, a missing/invalid argument, invalid JSON input. Exit 2. */
export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Configuration could not be resolved: no base URL, an unreadable key file, an invalid
 * baseUrl/apiKey combination rejected by `AutoHarnessClient` itself. Exit 2. */
export class CliConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliConfigError";
  }
}

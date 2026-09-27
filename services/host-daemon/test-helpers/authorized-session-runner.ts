import { SessionRunner, type SessionRunnerDeps } from "../src/session-runner.ts";

/** Host boundary fixture; admission/privacy tests instantiate the production class explicitly. */
export class AuthorizedSessionRunner extends SessionRunner {
  constructor(deps: SessionRunnerDeps) {
    super({ ...deps, authorizeCommandStart: deps.authorizeCommandStart ?? (async () => true) });
  }
}

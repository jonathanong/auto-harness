# Auto-Harness

Auto-Harness is an AI automation tool for your software factory.
It allows you to programmatically call your favorite CLI tools in interactive mode and manage sessions through the web.

Auto-Harness consists of the following architecture:

- AWS Lambda - the public endpoint for triggering workflows, which includes:
  - An API service
  - A web UI
- AWS DynamoDB - for storing data related to your workflow
- AWS S3 - for storing archival data for your workflow
- A service to run on your computer or VPS

Use cases for your auto-harness are:

- Automatically creating a pull request on CI failure
- Creating pull requests based on prompts
- Shepherding pull requests to merge

The service does not actually care what you send since it must be triggered programmatically. 

## Security Boundaries

The service itself does not contain any credentials except for its own credentials.
Instead, it is expected that your VPS (e.g. through environment variables or `.env` files) or your repository has the proper credentials set up.
Passing environment variables through the API is not supported.
Do not pass secrets through the prompt.

Auto-Harness supports custom CLI commands or environment variables when invoking each agent.
For example, you can instruct it to do `source .env && codex -p "prompt"`.
It is recommended to create a profile specific to the auto-harness non-interactive agents.

## Service Setup

1. Deploy with CloudFormation with admin credentials
2. Create users or service accounts
3. Add repositories using the UI

## VPS Setup

1. Clone the repo to your VPS
2. Start the service with
3. Add repositories with the CLI

## Worktrees

It is recommended to use worktrees for development.
Auto-Harness re-using worktrees instead of creating and deleting worktrees per session.
You set the worktrees, auto-harness will automatically create the worktrees if they are not set up yet.

You can also create a script for setting up or updating the worktree, for example something as simple as `git checkout -b claude/auto-harness/{random} && git fetch && git reset --hard origin/main && pnpm install`.

Similar to GitHub Actions, you can set labels on your worktrees, e.g. set the `claude` label for worktrees in `.claude/worktrees/*`, which can only run Claude.

The number of worktrees is your concurrency level. 
If there are not enough worktrees for a task, they will be queued with a priority.

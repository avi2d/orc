---
kind: how-to
---
# Run your first task

Run one task by hand, to see a run from the task file to its pull request before you set up a backlog.

## Before you begin

- [Git](https://git-scm.com) 2.48 or later, and [Node.js](https://nodejs.org).
- [Pi](https://pi.dev), the `@earendil-works/pi-coding-agent` [npm](https://www.npmjs.com) package, logged in to a model provider.
- [no-mistakes](https://github.com/kunchenguid/no-mistakes), installed as [Installing no-mistakes](../run/installing-no-mistakes.md) says.
- A project in a git checkout with a remote that no-mistakes can open a pull request on, such as [GitHub](https://github.com).

## Install orc

To put the `orc` command on your PATH:

1. Run `npm install -g @avi2dg/orc`.
1. Run `orc --version` to check it.

Orc prints `orc` and its version.
The npm package runs without Bun on Apple silicon macOS and Linux x64 with glibc.
If the compiled binary is missing, install Bun to run orc from source.
To upgrade orc later, run the same install command again.

## Name a provider and its models

To tell orc which models it may run:

1. Save `~/.orc/config.json` with one provider and the models for each role.

```json
{
  "providers": [{ "id": "opencode-go", "credential": "pi-login", "nono": { "upstream": "https://opencode.ai/zen/go/v1" } }],
  "models": { "implementer": "opencode-go/kimi-k3", "fixer": "opencode-go/kimi-k3", "orchestrator": "opencode-go/kimi-k3" }
}
```

[Configuring providers](../run/configuring-providers.md) shows every credential kind.

## Name the project's checks

To name the project's checks:

1. In the project, add a `.no-mistakes.yaml` file with at least one command under `commands`.
1. Commit that file.

```yaml
commands:
  lint: bun run lint
```

Follow the local-check and GitHub CI policy in [Local checks and CI](../run/running-a-task.md#local-checks-and-ci).

## Run the task

To run it:

1. Write the task in Markdown outside the project, such as `~/task.md`, with a `# ` title and what you want done.
1. Enter a clean checkout of the project.
1. Run `orc run ~/task.md --sandbox none`.
1. Read the report orc prints when the run ends.

Orc prints the branch, its commits, the checks, the review and the pull request link.
`--sandbox none` runs the agent on the host as your user.
With [nono](https://nono.sh) installed, drop the flag and the run works inside the nono sandbox.

## See what happened

To read the run afterwards:

1. Run `orc runs` to list recent runs with their status and pull request.
1. Run `orc show <run-id>` to see one run step by step.
1. Run `orc log <run-id> <step-id>` to print one step's output.

## Troubleshooting

### Orc refuses a checkout with uncommitted changes

The run copies the project from its last commit, so uncommitted work would be left out.
Commit or stash the changes and run the command again.

### Orc refuses the no-mistakes release

Upstream's install script fetches a release older than the one orc needs.
Install the release [Installing no-mistakes](../run/installing-no-mistakes.md) names.

## Related topics

- [A run](../concepts/run.md)
- [Running a task](../run/running-a-task.md)
- [Run a backlog from the chat](run-a-backlog.md)
- [Commands](../reference/commands.md)

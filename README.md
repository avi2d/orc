# orc

Say what needs doing, and orc runs it with AI agents across your machines and reports back.

Orc is one orchestrator for all your agent work.
You talk to it in a chat, it keeps the backlog, and it sends each task to a machine with room.
A terminal dashboard shows every machine, queue and account at a glance.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git 2.48 or later.
- Node, which the agent runs on.
- Pi, the `@earendil-works/pi-coding-agent` npm package, logged in to a model provider.
- no-mistakes, installed as [Installing no-mistakes](docs/run/installing-no-mistakes.md) says, for every run except `direct-PR`.
- pueue, to queue runs on each machine.

## Install

To install orc:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc && bun install --frozen-lockfile` to install the pinned dependencies.
1. Run `cd packages/run && bun link` to put the `orc` command on your PATH.
1. Run `orc --version` to check it.

Orc prints `orc` and its version.

## Run your first task

To run one task in a project:

1. Save `~/.orc/config.json` with the provider and models orc may run.
1. In the project, commit a `.no-mistakes.yaml` that names its checks.
1. Write the task in Markdown outside the project, such as `~/task.md`.
1. In a clean checkout of the project, run `orc run ~/task.md --sandbox none`.

```json
{
  "providers": [{ "id": "opencode-go", "credential": "pi-login", "nono": { "upstream": "https://opencode.ai/zen/go/v1" } }],
  "models": { "implementer": "opencode-go/kimi-k3", "fixer": "opencode-go/kimi-k3", "orchestrator": "opencode-go/kimi-k3" }
}
```

```yaml
commands:
  test: bun test
```

Orc prints the branch, its commits, the checks, the PR link when its run opened one, and the review on a `no-mistakes` run.
`--sandbox none` runs the agent on the host as your user.
With nono from https://nono.sh installed, drop the flag and the run works inside the nono sandbox.

## Run a backlog from the chat

To hand orc a stream of work:

1. Name your machines and accounts in `~/.orc/backlog/dispatch.json`.
1. Name your projects and their checkouts in `~/.orc/backlog/projects.json`.
1. Run `orc chat` and say the tasks.
1. Run `orc beat` from cron or launchd every few minutes.
1. Run `orc backlog` to see each task new, taken or closed.

Once a task the chat added closes, the chat posts it with its outcome and its reason.
The post carries the PR, or the report for a scout or task.
The chat also posts each alert once, and when any task's PR turns green, merges, closes or its run stalls.
[The backlog and the beat](docs/run/backlog-and-beat.md) shows both files and every option.

## Open the dashboard

To open the dashboard, run `bun run dashboard` from the repository root.
[The dashboard guide](docs/tui-dash.md) names each panel and the tools it reads.

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/run` | The orc command |
| `packages/cli` | The `tui-dash` command, which composes the panels into the dashboard |
| `packages/dashboard` | The dashboard host, which lays out the panels it is given |
| `packages/schema`, `packages/ui` | The dashboard's shared decoders, view models, theme and screen runner |
| `packages/alerts`, `packages/dispatch`, `packages/ledger`, `packages/queues`, `packages/quota`, `packages/resources`, `packages/schedules`, `packages/session-quota`, `packages/tasks` | One dashboard panel each |
| `dependency-cruiser.config.ts` | The panel border the lint holds every import to |
| `docs/adr` | The decision records |

## Related topics

- [Pick a task kind](docs/pick-a-task-kind.md)
- [Pick a delivery mode](docs/pick-a-delivery-mode.md)
- [Merge a PR and turn on yolo](docs/merge-a-pr.md)
- [Give a project its own instructions](docs/project-instructions.md)
- [Follow up on your upstream contributions](docs/upstream-contributions.md)
- [Where orc is going](docs/roadmap.md)
- [Contribute](docs/contribute.md)
- [The orc command in depth](packages/run/README.md)
- [The tui-dash dashboard](docs/tui-dash.md)

# orc

Say what needs doing, and orc runs it with AI agents across your machines and reports back.

Orc is one orchestrator for all your agent work.
You talk to it in a chat, it keeps the backlog, and it sends each task to a machine with room.
A terminal dashboard shows every machine, queue and account at a glance.

- **One front door.** Tell `orc chat` the work in plain words, or add a task file with `orc backlog add`.
- **Every kind of task.** Code changes land as pull requests today, and investigations and reports follow in the roadmap below.
- **Runs where there is room.** `orc beat` places each task on a machine with a free slot and an account with quota left.
- **Asks only when it must.** A task that needs your call waits with its question, and your answer starts it again with `orc run`.
- **Reviewed before you see it.** A code change passes your checks and a no-mistakes review, and lands as a pull request on a provider no-mistakes supports.
- **Never loses work.** The backlog, the run history and the queues live on disk, so a restart picks up where it stopped.
- **See it all.** `tui-dash` shows quota, machines, queues, tasks and alerts in one terminal screen.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git.
- Node, which the agent runs on.
- Pi, the `@earendil-works/pi-coding-agent` npm package, logged in to a model provider.
- no-mistakes, installed as [Installing no-mistakes](packages/run/README.md#installing-no-mistakes) says.
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

Orc prints the branch, its commits, the checks, the review and the PR link when its run opened one.
`--sandbox none` runs the agent on the host as your user.
With nono from https://nono.sh installed, drop the flag and the run works inside the nono sandbox.

## Run a backlog from the chat

To hand orc a stream of work:

1. Name your machines and accounts in `~/.orc/backlog/dispatch.json`.
1. Name your projects and their checkouts in `~/.orc/backlog/projects.json`.
1. Run `orc chat` and say the tasks.
1. Run `orc beat` from cron or launchd every few minutes.
1. Run `orc backlog` to see each task new, taken or closed.

The chat posts each task it added since it started once the task closes, with its outcome, its reason and its PR when its run opened one.
[The backlog and the beat](packages/run/README.md#the-backlog-and-the-beat) shows both files and every option.

## Open the dashboard

To open the dashboard, run `bun run dashboard` from the repository root.
[The dashboard guide](docs/tui-dash.md) names each panel and the tools it reads.

## Where orc is going

Orc grows toward the full orchestrator one step at a time.

| Capability | State |
| --- | --- |
| Chat and backlog as the front door | Ships today |
| Runs placed by free slot and account quota, across machines | Ships today |
| Code changes through checks and no-mistakes review into a pull request | Ships today |
| Terminal dashboard with quota, machines, queues, tasks and alerts | Ships today |
| Orchestrator rules the chat follows | Next |
| The chat posts every close, after a restart too | Next |
| Decisions held for you with a reason, answered from the chat | Next |
| Runs parked on a question resume on your answer | Next |
| Reports, investigations and machine tasks that end without a pull request | Next |
| Per-project delivery: direct pull request or full review | Next |
| Merge on your word, refusing red checks | Next |
| Stalled runs and machine load flagged in the chat | Next |
| Alerts and pull request events posted in the chat | Next |
| Decision boards you answer once | Next |
| Per-project instructions the run and the chat both read | Next |
| A fresh checkout before every run, and follow-ups on upstream changes | Next |

Today a run counts as done once Pi stops cleanly with `ORC_COMPLETE`, the branch holds a new commit, the checks pass and no-mistakes opens a pull request with green CI.
A task that changes no code closes failed.
A queued run from the backlog runs without the nono sandbox.

## Contribute

To run the checks:

1. Run `bun run build` to build the workspace.
1. Run `bun run lint` to lint it.
1. Run `bun run typecheck` to typecheck it.
1. Run `bun run test` to test it.

The secrets gate in `bun run lint` fails a change that adds a term from a private list of host and person names.
The list is a JSON file in the format [checks-secrets](https://github.com/avi2d/checks/blob/main/docs/gates/checks-secrets.md#the-private-pack) reads, with keys such as `hosts` and `names`.
It lives outside orc, at `~/.config/checks/secrets-pack.json`, or wherever `CHECKS_SECRETS_PACK` points.
Lint fails on a machine with no list, so no change skips the gate.
In CI the `CHECKS_SECRETS_PACK` repository secret holds the list.

A panel package reaches another package only through the schema and ui packages, and `bun run lint` refuses any other import.

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

- [The orc command in depth](packages/run/README.md)
- [The tui-dash dashboard](docs/tui-dash.md)

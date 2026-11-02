# orc

Tell orc what needs doing, and it runs each task with an AI agent on a machine that has room.

- **Say it or file it.** Tell `orc chat` what you need, or add a task file with `orc backlog add`.
- **Runs where there is room.** `orc beat` starts each task on a machine with a free slot and an account with quota left.
- **Waits its turn.** A task that depends on others starts once they close done.
- **Safe by default.** Direct runs use the nono sandbox by default.
  Runner queued tasks run without a sandbox.
  Each run works on its own branch in its own copy and runs your checks.
- **Reviewed before you see it.** no-mistakes reviews the branch and opens a pull request for a code change, and orc never merges.
- **Watch it all.** The `tui-dash` dashboard shows quota, machines, queues and tasks in the terminal.

## Before you begin

- Bun, at the version `.bun-version` pins.
- Git.
- Pi, the `@earendil-works/pi-coding-agent` npm package, logged in to a model provider.
- no-mistakes, installed as [Installing no-mistakes](packages/run/README.md#installing-no-mistakes) says.
- nono from https://nono.sh, for the default sandbox, or `--sandbox none` to run without it.

## Install

To install orc:

1. Run `git clone https://github.com/avi2d/orc.git` to clone the repository.
1. Run `cd orc && bun install --frozen-lockfile` to install the pinned dependencies.
1. Run `cd packages/run && bun link` to put the `orc` command on your PATH.
1. Run `orc --version` to check it.

Orc prints `orc` and its version.

## Run your first task

To run one task in a project:

1. Save `~/.orc/config.json` with the provider and models orc may run, as below.
1. Add a `.no-mistakes.yaml` naming the project's checks, and commit it.
1. Write the task in Markdown outside the project checkout, such as `~/task.md`.
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

`--sandbox none` runs the agent on the host as your user.
Once nono is installed, drop the flag to run inside the sandbox.
Orc prints the branch, the commits, the checks, the review and the PR link when no-mistakes opens one.
A run counts as done only when the agent commits, the checks pass, and no-mistakes opens a PR and reports CI green.
A task that changes no code ends failed, because Pi made no commit.
`orc runs` lists past runs, and `orc show <run-id>` walks one step by step.

## Queue tasks across machines

To keep a backlog that starts itself:

1. Name your machines and accounts in `~/.orc/backlog/dispatch.json`, and your projects in `~/.orc/backlog/projects.json`.
1. Run `orc chat` and say the tasks, or run `orc backlog add <project> ~/task.md`.
1. Run `orc beat` from cron or launchd every few minutes.
1. Run `orc backlog` to see each task new, taken or closed.

[The backlog and the beat](packages/run/README.md#the-backlog-and-the-beat) shows both files and every option.

## Open the dashboard

To open the dashboard, run `bun run dashboard` from the repository root.
[The dashboard guide](docs/tui-dash.md) names each panel and the tools it reads.

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

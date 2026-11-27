# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/public/orc-logo-dark.svg"><img src="docs/public/orc-logo-light.svg" alt="orc" width="200"></picture>

<div align="center">

One chat to run your AI agent work on all your machines and models, with a backlog, live monitoring and Herdr App dashboards.

[Docs](https://avi2d.github.io/orc/) • [Install](#install) • [Run your first task](#run-your-first-task)

</div>

<div align="center">

<img src="docs/images/orc-hero-640.webp" alt="An orc arranging task tiles at a desk" width="360">

</div>

## Before you begin

- Git 2.48 or later.
- Node, which orc's npm launcher and the agent both run on.
- nono from https://nono.sh, to sandbox a run you start by hand with `orc run --sandbox nono`.
- Pi, the `@earendil-works/pi-coding-agent` npm package, logged in to a model provider.
- no-mistakes v1.90.0 or later, installed as [Installing no-mistakes](docs/run/installing-no-mistakes.md) says, for every run except `direct-PR` and `orc`.
- pueue, to queue runs on each machine, with its daemon started by `pueued -d`.

## Install

To install orc:

1. Run `npm install -g @avi2dg/orc`.
1. Run `orc --version`.

Orc prints its version.
The npm package runs without Bun on Apple silicon macOS and Linux x64 with glibc.
If the compiled binary is missing, install Bun to run the bundled `dist/bin.js`.
To upgrade orc, run the same install command again or follow [Updating orc](docs/run/updating-orc.md).
The beat's hourly update needs an npm prefix you can write to, and that page says how to turn it off for a root-owned one.
To run orc from a checkout of this repository instead, follow [Contribute](docs/contribute.md#run-orc-from-a-checkout).

## Run your first task

To run one task in a project:

1. Save `~/.orc/config.json` with the provider and models orc may run.
1. In the project, commit a `.no-mistakes.yaml` that names its checks.
1. Write the task in Markdown outside the project, such as `~/task.md`, with a `#` title line and what you want done.
1. In a clean checkout of the project, run `orc run ~/task.md --sandbox none`.

```json
{
  "providers": [{ "id": "opencode-go", "credential": "pi-login", "nono": { "upstream": "https://opencode.ai/zen/go/v1" } }],
  "models": { "implementer": "opencode-go/kimi-k3", "fixer": "opencode-go/kimi-k3", "orchestrator": "opencode-go/kimi-k3" }
}
```

```yaml
commands:
  lint: bun run lint
```

GitHub CI runs repository tests.
Orc prints the branch, its commits, the checks, the PR link when its run opened one, and the review on a `no-mistakes` run.
`--sandbox none` runs the agent on the host as your user without a per-agent sandbox.
Queued tasks always pass that flag.
Their safety boundary is the isolated space around the whole agent system, as [Running without a sandbox](docs/run/running-without-a-sandbox.md) describes.
That is the default: orc runs without a per-agent sandbox.
To sandbox a run you start by hand, pass `--sandbox nono` instead.

## Run a backlog from the chat

To hand orc a stream of work:

1. Name your machines and accounts in `~/.orc/backlog/dispatch.json`.
1. Name your projects and their checkouts in `~/.orc/backlog/projects.json`.
1. Run `orc chat` and say the tasks.
1. Run `orc beat` from cron or launchd every few minutes.
1. Run `orc backlog` to see each task new, taken or closed.

Once a task closes, the chat posts it with its outcome and its reason.
The post carries the PR, or the report for a scout or task.
The chat also posts each alert once.
It posts an event when a task's run stalls, when a closed task's PR turns green, merges or closes without merging, and when a worker split proposal lands.
[Backlog configuration](docs/run/backlog-configuration.md) shows both files and every option.

## Open the dashboard

To open the dashboard, run `bun run dashboard` from the repository root.
[The dashboard guide](docs/dash.md) names each panel and the tools it reads.

## Where things are

| Path | What it holds |
| --- | --- |
| `packages/run` | The orc command |
| `packages/cli` | The `orc-dash` command, which composes the panels into the dashboard |
| `packages/dashboard` | The dashboard host, which lays out the panels it is given |
| `packages/schema`, `packages/ui` | The dashboard's shared decoders and view models, and its OpenTUI theme and layout helpers |
| `packages/alerts`, `packages/attention`, `packages/dispatch`, `packages/ledger`, `packages/queues`, `packages/quota`, `packages/resources`, `packages/schedules`, `packages/session-quota`, `packages/tasks` | One panel, box or tool of the dashboard each |
| `packages/herdr-app` | The Herdr App mods and layout, which `orc app install` copies into the App |
| `dependency-cruiser.config.ts` | The import rules the lint enforces between packages |

## Related topics

- [What orc does](docs/features.md)
- [Pick a task kind](docs/pick-a-task-kind.md)
- [Pick a delivery mode](docs/pick-a-delivery-mode.md)
- [Merge a PR and turn on yolo](docs/merge-a-pr.md)
- [Give a project its own instructions](docs/project-instructions.md)
- [Follow up on your upstream contributions](docs/upstream-contributions.md)
- [Where orc is going](docs/roadmap.md)
- [Contribute](docs/contribute.md)
- [The orc command in depth](packages/run/README.md)
- [The orc-dash dashboard](docs/dash.md)
- [Show orc in the Herdr App](docs/herdr-app.md)

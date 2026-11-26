---
kind: reference
---
# Run the queues panel

The queues panel shows [pueue](https://github.com/Nukesor/pueue) and [GitHub Actions](https://github.com/features/actions) runs.

## Run the queues tool

To run the live queues panel, run `orc-dash panel queues`.
The panel reads pueue and the GitHub Actions runs and paints again every 10 seconds.
Each machine's panel counts the running, queued and paused tasks, the ended ones and the failed ones.
It lists the running tasks, then the ended ones newest first.
Each run shows its project, when it started, how long it took and its command, and a failed run says why, such as `exit 1` or `killed`.

The groups panel shows each pueue group's state and parallel limit.
The actions panel shows waiting and running GitHub Actions jobs.

Press `q` or Control C to quit.
Run `orc-dash panel queues --print` to print one frame.
The panel drops task environments from pueue readings because they can hold secrets.

To configure the queues, set these variables where the panel runs:

| Variable | What it holds |
| --- | --- |
| `ORC_DASH_REMOTE_PUEUE` | The shell command that prints the other machine's `pueue status --json`, such as `ssh other-host pueue status --json` |
| `ORC_DASH_REMOTE_MACHINE` | The other machine's name on its panel, `remote` when unset |
| `ORC_DASH_MACHINE` | This machine's name on its panel, `local` when unset |
| `ORC_DASH_ACTIONS_REPO` | The repository whose runs the panel lists, such as `example/shop`. When unset, [gh](https://cli.github.com) lists the runs of the repository the panel runs in, and the panel names it `this repository` |

With `ORC_DASH_REMOTE_PUEUE` unset or blank, the panel reads this machine's pueue alone.
The command runs through `sh -c` with a 20 second limit, beside this machine's own read.
The session quota tool reads the same two machine names.

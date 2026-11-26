---
aside: false
pageClass: wide-page part-run
kind: explanation
---
# A run

A run is one attempt at one task by `orc run`, from a task file to a pull request or a report.
The beat starts most runs through the runner, and you can start one by hand in any clean checkout with `orc run <task-file>`.

![A run: one attempt at one task](../diagrams/run.svg)

## An isolated copy

Orc refuses a checkout with uncommitted changes.
A ship run then makes a [git](https://git-scm.com) worktree of the project on a new branch under `~/.orc/worktrees`, so the agent never touches your own checkout.
Before [Pi](https://pi.dev) starts, a ship run runs the `prepare` command from the project's `.no-mistakes.yaml`, such as an install.

## The agent

Orc runs only the Pi agent, and it starts Pi itself.
By default, a run you start by hand runs on the host without a per-agent sandbox.
Use `--sandbox nono` to run it inside the [nono](https://nono.sh) sandbox.
The agent file `implementer.md` holds Pi's instructions, and `config.json` names the model.
The prompt is the task, and it asks Pi to print `ORC_COMPLETE` on its own line once the work is committed.

Orc watches Pi while it works.

- It stops a Pi that has printed nothing for 45 minutes with no tool running.
- When Pi fails one command 3 times in a row, orc tells you through the attention queue.
- When Pi fails one command 6 times in a row, orc pauses the run and asks you whether to continue.
- Pi can ask you a question mid-run with its `orc_ask` tool instead of guessing.

## When a run counts as done

A ship run records success only when all of these hold.

1. Pi's final reply stopped cleanly with `ORC_COMPLETE` on its own line.
1. The branch holds at least one new commit.
1. The configured local checks pass.
1. The pull request is open.

A scout or task run makes no branch and no pull request.
It counts as done once Pi wrote `agent-report.md` into the run folder.

## The record

Each run keeps its task, its logs, its Pi session and its `report.md` in `~/.orc/runs/<run-id>`.
A run that ends done or failed removes its Pi folder, `session/agent`, which holds the run's Pi settings and its installed packages, or links to the packages orc shares between runs.
A parked run and a stopped run keep that folder.
`orc runs` lists the runs, `orc show <run-id>` shows one step by step, and `orc log <run-id> <step-id>` prints one step's output.

## Stopping and resuming

A ship run that stops can resume on its branch with `orc run --branch <name>`.
Orc skips the steps the record marks passed, and Pi resumes its earlier session.
A run whose session reaches 300 turns or 5 compactions writes `handover.md`, so the next run on the branch starts from that note.

## Related topics

- [Checks and review](checks-and-review.md)
- [The runner](runner.md)
- [Running a task](../run/running-a-task.md)
- [How orc runs Pi](../run/how-orc-runs-pi.md)
- [Seeing runs](../run/seeing-runs.md)

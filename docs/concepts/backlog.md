---
aside: false
pageClass: wide-page part-backlog
kind: explanation
---
# The backlog

The backlog is the one list of everything orc has to do, kept as one Markdown file per task in `~/.orc/backlog`.
It lives only on the machine that runs `orc beat`, and every other part of orc reads or changes it through the `orc backlog` commands.

![The backlog: where a task file sits, and how it moves](../diagrams/backlog.svg)

## A task and its states

A task file sits in the folder `new`, `taken` or `closed`, and the folder it sits in is its state.
The beat moves the file from `new` to `taken` by rename, so of two beats only one takes a task.
A taken task is marked started once its start command runs.
A closed task keeps its outcome, which is `done`, `failed`, `stopped` or `dropped`, with the reason and the pull request or report it ended in.

Orc names each task `<project>-<n>`, as in `orc-9`.
The task's title and body are your words, and they become the prompt of its run.

## The kinds of task

The kind decides how a task ends.

| Kind | What it does | How it ends |
| --- | --- | --- |
| `ship`, the default | Changes code | A pull request |
| `scout` | Reads the checkout and changes nothing | A report |
| `task` | Does the work it describes | A report with its evidence |
| `parent` | Holds the done criteria for work too large for one pull request | A final check once its children are done |
| `decision` | Asks you a question and never runs | Your answer |

A request too large for one pull request becomes a parent with one child per slice.
You can split it by hand, or a planner model can split it when you add it.
A run can also stop and propose the split itself.

## What keeps a new task waiting

A new task does not start until the beat finds nothing in its way.
`orc backlog --json` names the reason as `waiting`, with one of these kinds.

| Kind | The task waits because |
| --- | --- |
| `no-priority` | It has no priority, and a task with no priority never starts |
| `held` | You held it with `orc backlog hold` until you answer |
| `parked` | Its run stopped on a question that has no answer yet |
| `depends` | A task it depends on is not done, or a parent's children are not done |
| `decision` | It is a decision, which only your answer closes |
| `room` | No machine has a free slot, or no account has room |

A task the chat adds has no priority until you give it one, so nothing starts without your say.
Priority runs from 0, which starts first, to 4.

## The conversation on a task

Holds, questions, answers and notes all stay with the task.
`orc backlog thread <task-id>` prints them in order, with who said each one.
To send a closed task's open pull request back for another pass, run `orc backlog send-back <task-id> <words>`, and the same run resumes with your words as the review.
To run a failed or stopped task again, run `orc backlog retry <task-id>`.

## Related topics

- [The beat](beat.md)
- [The backlog and the beat](../run/backlog-and-beat.md)
- [Task kinds](../run/task-kinds.md)
- [Pick a task kind](../pick-a-task-kind.md)

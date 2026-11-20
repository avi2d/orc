---
kind: reference
outline: deep
---
# Commands

Every `orc` command and subcommand, with the text its `--help` prints.
`bun run build` writes this whole page from that help text through `scripts/docs-commands.ts`, so a change belongs in `packages/run/src/app` and never here.

## Every command

```text
orc runs AI agent tasks across your machines and reports back.

Usage: orc <command> [<args>]
       orc --help | --version

Run a task:
  run        Run one task file in this checkout and end in a PR or a report

Runs and their results:
  runs       List recent runs with their status and PR
  show       Show one run step by step
  log        Print the output of one step of a run
  score      Score one step of a run from 1 to 5
  refusals   Count the gates and rules past runs kept hitting

The backlog and the beat:
  backlog    See the backlog, and add, hold, answer or close its tasks
  attention  See everything that waits on you or the decider
  beat       Start what can start and close what finished
  merge      Merge a closed task's PR once its checks are green

The runner:
  runner     Queue, renew, read and stop task runs through pueue
  heavy      Check and watch the queue of heavy tool calls
  version    Print the orc version this machine runs
  machines   List the orc version each dispatch machine runs

Chat and the app:
  chat       Talk to the orchestrator, which adds, holds and answers tasks
  app        Install the orc mods and layout into the Herdr App

Updating orc:
  update     Install the newest published orc when it is newer than this one

Run orc <command> --help to learn what a command does and the options it takes.
```

## Run a task

### orc run

```text
Usage: orc run [<task-file>] [--kind <ship|scout|task|parent>]
           [--delivery <no-mistakes|direct-PR>] [--branch <name>]
           [--sandbox <nono|none>] [--token-file <path>] [--provider <id>]
           [--implementer-model <model>] [--fixer-model <model>]
           [--implementer-thinking <level>] [--fixer-thinking <level>]
           [--instructions <path>] [--allow ask-user] [--answer <id>=<text>]

Runs the task in the clean checkout you are in: Pi writes the change, the checks
run, and no-mistakes reviews it and opens the PR. Give --branch with no task
file to resume a stopped run on that branch.

Options:
  --kind <ship|scout|task|parent>
                            What the task ends in. ship ends in a PR, scout and
                            task end in a report, and parent runs a parent's
                            final check. Defaults to ship.
  --delivery <no-mistakes|direct-PR>
                            How a ship task reaches its PR. Defaults to
                            no-mistakes, and direct-PR opens the PR with no
                            review.
  --branch <name>           The branch to commit to, or to resume. Defaults to
                            orc/<run-id>.
  --sandbox <nono|none>     Where the agent runs. Defaults to nono, and none
                            runs it on the host as you.
  --token-file <path>       A file holding the provider token the run uses.
  --provider <id>           The provider id from config.json the run must use.
  --implementer-model <model>
                            The implementer model, used instead of the one
                            config.json names.
  --fixer-model <model>     The fixer model, used instead of the one config.json
                            names.
  --implementer-thinking <level>
                            The implementer thinking level, used instead of the
                            one the agent file names.
  --fixer-thinking <level>  The fixer thinking level, used instead of the one
                            the agent file names.
  --instructions <path>     A project instructions file handed to Pi.
  --allow ask-user          Decline findings marked exactly ask-user, on a
                            resume. Findings with any other action still wait as
                            questions.
  --answer <id>=<text>      Answer a review question or an ask-user finding by
                            its id, on a resume. Give it once per answer.

Examples:
  orc run ~/task.md --sandbox none
  orc run --branch orc/fix-login --answer question-1="keep the old flag"
```

## Runs and their results

### orc runs

```text
Usage: orc runs [--json [--local]]

Lists the recent runs this home recorded, newest first, with each run's project,
branch, status and PR.

Options:
  --json   Print the runs as an orc.runs.v1 JSON document.
  --local  With --json, read only this machine's runs.

Examples:
  orc runs
  orc runs --json
```

### orc show

```text
Usage: orc show <run-id> [--json]

Shows one run step by step: each step's agent, session, signals, latest score
and evidence. Take the run id from orc runs.

Options:
  --json  Print the run as an orc.show.v1 JSON document, which gives each step
          its id.

Examples:
  orc show 20261114-001721-4889ea
  orc show 20261114-001721-4889ea --json
```

### orc log

```text
Usage: orc log <run-id> <step-id>

Prints the log one step of a run wrote, such as agent.log for an implement step.
Take the step id from orc show <run-id> --json.

Examples:
  orc log 20261114-001721-4889ea 3
```

### orc score

```text
Usage: orc score <run-id> <step> <1 to 5> [<note>]

Records a score from 1 to 5 for one step of a run, with an optional note, and
orc show prints the latest score. Name the step as fix#1 for the first fix
attempt, or by its id from orc show --json.

Examples:
  orc score 20261114-001721-4889ea implement 4 "clean, one stray comment"
```

### orc refusals

```text
Usage: orc refusals [--json]

Counts the runs that hit each gate, and each rule where the failure names a
stable rule code.

Options:
  --json  Print the counts as an orc.refusals.v1 JSON document.

Examples:
  orc refusals
```

## The backlog and the beat

### orc backlog

```text
Usage: orc backlog [--json]
       orc backlog <subcommand> [<args>]

With no subcommand, prints the new, taken and closed tasks beside the projects
and each machine's busy slots. The backlog lives in ~/.orc/backlog on the
machine that runs orc beat.

Subcommands:
  add        Add a task to the backlog
  edit       Replace the text of a task that has not started
  origin     Record where a parked task's run lives
  close      Close a task by hand as done or failed
  stop       Kill a task's run and close the task stopped
  drop       Drop a new task with a reason
  posted     Mark a closed task or an event as posted to the chat
  hold       Keep a new task back until you answer it
  answer     Answer a held, parked or decision task
  send-back  Send a closed task's open PR back for another pass
  note       Leave a note on a task
  thread     Show a task's conversation in order
  depend     Change the tasks a new task waits for
  plan       Show a parent task's plan, or drop a child from it
  priority   Set or clear a new task's priority

Options:
  --json  Print the backlog as an orc.backlog.v1 JSON document.

Examples:
  orc backlog
  orc backlog add orc ~/task.md

Run orc backlog <subcommand> --help for one subcommand.
```

#### orc backlog add

```text
Usage: orc backlog add <project> <task-file|->
           [--kind <ship|scout|task|parent|decision>] [--internal]
           [--machine <name>] [--parent <task-id>] [--depends-on <task-id>]
           [--priority <0-4>]

Adds a task for a project that projects.json names, and prints its new id, such
as orc-9. Give - as the task file to read the task from standard input.

Options:
  --kind <ship|scout|task|parent|decision>
                            What the task ends in. Defaults to ship, or to the
                            kind the task file names. A decision is a question
                            for the captain that never runs and takes no
                            --priority or --machine.
  --internal                Mark a ship task internal-only, which a
                            no-mistakes-prod-only project ships as direct-PR.
  --machine <name>          Run the task on this machine only.
  --parent <task-id>        Add the task as a child of a new parent task.
  --depends-on <task-id>    A task this one waits for. Give it once per task.
  --priority <0-4>          Order new tasks by this priority, 0 first. One with
                            none goes last.

Examples:
  orc backlog add orc ~/task.md --machine linux-box
  orc backlog add orc ~/part.md --parent orc-12 --depends-on orc-13
```

#### orc backlog edit

```text
Usage: orc backlog edit <task-id> <task-file|->

Replaces the title and the body of a new or held task and keeps its id, kind,
hold, dependencies and parked questions. Give - to read the text from standard
input.

Examples:
  orc backlog edit orc-9 ~/task.md
```

#### orc backlog origin

```text
Usage: orc backlog origin <task-id> <machine> <run-id>

Records the machine and the run id that a parked task resumes.

Examples:
  orc backlog origin orc-9 linux-box run-42
```

#### orc backlog close

```text
Usage: orc backlog close <task-id> <done|failed> [<reason>]

Closes a started task as done or failed, with an optional reason, for a machine
whose start command orc does not run. On a decision, failed drops it, and done
is refused, since only orc backlog answer closes a decision done.

Examples:
  orc backlog close orc-9 failed "the machine was rebuilt"
```

#### orc backlog stop

```text
Usage: orc backlog stop <task-id>

Kills the task's run through the machine that started it and closes the task
stopped. Run it where the backlog lives.

Examples:
  orc backlog stop orc-9
```

#### orc backlog drop

```text
Usage: orc backlog drop <task-id> <reason>

Closes a new task as dropped with the reason it never runs. A taken or started
task ends with orc backlog stop instead.

Examples:
  orc backlog drop orc-9 "duplicate of orc-12"
```

#### orc backlog posted

```text
Usage: orc backlog posted <task-id|event-key>

Records that the chat posted a closed task or an event, so no later chat posts
it again.

Examples:
  orc backlog posted orc-9
```

#### orc backlog hold

```text
Usage: orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>]
           [--question <text>]

Holds a new task for a decision of yours, so the beat does not start it until
you answer with orc backlog answer.

Options:
  --reason <text>       Why the task waits for you. Required.
  --until <YYYY-MM-DD>  The date you mean to answer by. A past date releases
                        nothing.
  --question <text>     One decision to answer, named question-1 onward. Give it
                        once per question.

Examples:
  orc backlog hold orc-9 --reason "pick the API" --until 2026-12-01
  orc backlog hold orc-9 --reason "two calls" --question "REST or gRPC?"
```

#### orc backlog answer

```text
Usage: orc backlog answer <task-id> [--expect <held|parked>] [--generation <n>]
           <words|question-id=text>

Answers a held task, a parked run's question, a run waiting at its gate or a
decision. Give question-id=text to answer one open question, or plain words to
answer the hold. Answering a decision closes it done, and its question and
answer go into the run of each task that depends on it.

Options:
  --expect <held|parked>  Answer only when the task waits in this decision, so a
                          stale answer is refused.
  --generation <n>        The hold generation the answer is for. Needed with
                          --expect held.

Examples:
  orc backlog answer orc-9 use the REST API
  orc backlog answer orc-9 question-1=REST
```

#### orc backlog send-back

```text
Usage: orc backlog send-back <task-id> <words>

Moves a closed task whose PR is still open back to new, parked on its branch
orc/<task-id> with your words as the review. The next beat resumes its run on
that branch, where the implementer takes the review in the session it worked in,
the checks run again, and the push updates the same PR. Run it again before the
beat starts the task to add more words, and the run gets them all. Refused when
the task is neither closed nor sent back, names no PR, or its PR is merged or
closed.

Examples:
  orc backlog send-back orc-9 rename the flag to --dry-run
```

#### orc backlog note

```text
Usage: orc backlog note <task-id> <words>

Appends a note to the task's notes file. A note holds nothing and answers
nothing, so it never changes when the beat starts the task.

Examples:
  orc backlog note orc-9 the login page moved to /auth
```

#### orc backlog thread

```text
Usage: orc backlog thread <task-id> [--json]

Prints a task's holds, questions, decisions, answers, deliveries, withdrawals
and notes, oldest first. It works on a closed task too.

Options:
  --json  Print the thread as an orc.thread.v1 JSON document.

Examples:
  orc backlog thread orc-9
  orc backlog thread orc-9 --json
```

#### orc backlog depend

```text
Usage: orc backlog depend <task-id> --on <task-id>[,<task-id>...]
       orc backlog depend <task-id> --clear

Replaces the whole list of tasks a new or held task waits for, or empties it
with --clear.

Options:
  --on <task-id>[,<task-id>...]
                            The comma-separated tasks it waits for.
  --clear                   Wait for no task.

Examples:
  orc backlog depend orc-9 --on orc-7,orc-8
  orc backlog depend orc-9 --clear
```

#### orc backlog plan

```text
Usage: orc backlog plan <task-id> [--drop <task-id>]

Prints a parent task's count, how it was split, and one line per child with its
state and what it waits on.

Options:
  --drop <task-id>  Remove this new child from the plan.

Examples:
  orc backlog plan orc-12
  orc backlog plan orc-12 --drop orc-14
```

#### orc backlog priority

```text
Usage: orc backlog priority <task-id> <0-4|none>

Sets the priority that orders new tasks in the beat, 0 first and none last, or
clears it with none. It refuses a task that is taken, started or closed.

Examples:
  orc backlog priority orc-9 0
  orc backlog priority orc-9 none
```

### orc attention

```text
Usage: orc attention [--json]
       orc attention answer <item-id> <words>

With no subcommand, prints every open item in the attention queue, oldest first,
such as review questions, red checks and PRs ready to merge.

Subcommands:
  answer  Answer one item in the attention queue

Options:
  --json  Print the queue as an orc.attention.v1 JSON document.

Examples:
  orc attention
  orc attention --json

Run orc attention <subcommand> --help for one subcommand.
```

#### orc attention answer

```text
Usage: orc attention answer <item-id> <words>

Closes one item with your words. A review question or an overdue wait is
answered with orc backlog answer instead.

Examples:
  orc attention answer orc-9.run-died restarted it by hand
```

### orc beat

```text
Usage: orc beat [--json]

Reads the room on each machine, starts each task that waits on nothing, closes
finished runs and relays answers. Run it from cron or launchd every few minutes.

Options:
  --json  Print the beat as an orc.beat.v1 JSON document.

Examples:
  orc beat
```

### orc merge

```text
Usage: orc merge <task-id> [--basis <captain-word|yolo-green>]

Merges the PR of a closed task with a squash at the head it checked, and refuses
a PR that is not open or not green. When the PR is behind its base, runs
GitHub's update-branch at the checked head, waits up to 20 minutes for the
checks on the new head and merges it once they are green. When update-branch
reports a merge conflict or a check on the new head is red, merges nothing and
sends the task back for a fix as orc backlog send-back does.

Options:
  --basis <captain-word|yolo-green>
                            Why the merge is allowed. Defaults to captain-word,
                            and yolo-green needs a project with yolo set.

Examples:
  orc merge orc-9
  orc merge orc-9 --basis yolo-green
```

## The runner

### orc runner

```text
Usage: orc runner <subcommand> [<args>]

The commands the beat runs on each machine to hand a task to pueue, keep its
token fresh, read how its run went and stop it. You run orc runner result and
orc runner kill yourself.

Subcommands:
  start   Queue the beat's task in pueue as an orc run
  queue   Queue a task read as JSON on standard input
  renew   Replace the token a queued task holds
  hold    Run a task's command once its token is live
  token   Print a Claude credentials file as a token document
  result  Show pueue's state and the latest run of a task
  kill    Stop a task's run on this machine
  answer  Hand answers to a run waiting at its review gate
  load    Print this machine's load and heavy queue

Examples:
  orc runner result orc-9
  orc runner kill orc-9

Run orc runner <subcommand> --help for one subcommand.
```

#### orc runner start

```text
Usage: orc runner start [-- <command that runs orc there>]

The start command a machine names in dispatch.json. It reads the task from the
beat's ORC_TASK_* variables and queues orc run in the project's checkout on
branch orc/<task-id>.

Options:
  -- <command>  Run it on another machine through this command, such as ssh
                linux-box orc.

Examples:
  orc runner start
  orc runner start -- ssh linux-box orc
```

#### orc runner queue

```text
Usage: orc runner queue

The far side of orc runner start -- <command>. It reads the task as JSON on
standard input, so the task text never passes through a remote shell.

Examples:
  orc runner queue < task.json
```

#### orc runner renew

```text
Usage: orc runner renew [-- <command that runs orc there>]

Reads a task and its fresh token as JSON on standard input and replaces the
token the task holds.

Options:
  -- <command>  Run it on another machine through this command, such as ssh
                linux-box orc.

Examples:
  orc runner renew -- ssh linux-box orc < renewal.json
```

#### orc runner hold

```text
Usage: orc runner hold <task-id> [--label <label>] -- <run command>

What pueue runs for a task with a token. It starts the run only while the token
is live, and otherwise waits for a fresh one.

Options:
  --label <label>   The pueue label of another home's run. Defaults to this
                    home's label for the task.
  -- <run command>  The orc run command to start. Required.

Examples:
  orc runner hold orc-9 -- orc run ~/.orc/runner/orc-9.md --sandbox none
```

#### orc runner token

```text
Usage: orc runner token <claude-credentials.json>

A token command for dispatch.json. It reads a file in Claude Code's credentials
shape and prints an orc.token.v1 document, only into a pipe.

Examples:
  orc runner token ~/.claude/.credentials.json > token.json
```

#### orc runner result

```text
Usage: orc runner result <task-id> [--json] [--label <label>] [--stdin-label]
           [-- <command that runs orc there>]

Names pueue's state for the task and the latest orc run on orc/<task-id> with
its PR.

Options:
  --json           Print the result as an orc.runner.v1 JSON document.
  --label <label>  The pueue label of another home's run. Defaults to this
                   home's label for the task.
  --stdin-label    Read the label as JSON on standard input, as a forwarded read
                   sends it.
  -- <command>     Run it on another machine through this command, such as ssh
                   linux-box orc.

Examples:
  orc runner result orc-9
  orc runner result orc-9 --json -- ssh linux-box orc
```

#### orc runner kill

```text
Usage: orc runner kill <task-id> [--label <label>] [--stdin-label]

Kills the running pueue task for the task, or removes it while still queued, and
marks its orc runs stopped. The next beat closes the task stopped.

Options:
  --label <label>  The pueue label of another home's run. Defaults to this
                   home's label for the task.
  --stdin-label    Read the label as JSON on standard input, as a forwarded kill
                   sends it.

Examples:
  orc runner kill orc-9
```

#### orc runner answer

```text
Usage: orc runner answer <task-id>

Reads answers as JSON on standard input and writes them into the waiting run's
answers.json.

Examples:
  orc runner answer orc-9 < answers.json
```

#### orc runner load

```text
Usage: orc runner load

Prints the five-minute load average the beat compares against a load limit, then
the calls queued in the heavy queue.

Examples:
  orc runner load
```

### orc heavy

```text
Usage: orc heavy <subcommand>

Each machine queues heavy calls such as test runs and builds through stand-ins,
one at a time, so two of them never overload the machine together.

Subcommands:
  path        Create the heavy tool stand-ins and print their folder
  check       Read the heavy queue's slots, calls and bypasses
  watch       Arm the watchdog for stalled heavy calls
  watch-once  Run one watchdog pass and print its counts

Examples:
  orc heavy check

Run orc heavy <subcommand> --help for one subcommand.
```

#### orc heavy path

```text
Usage: orc heavy path

Writes a stand-in for each heavy tool into ~/.orc/heavy/bin and prints that
folder.

Examples:
  orc heavy path
```

#### orc heavy check

```text
Usage: orc heavy check [--json]

Prints the slots, the running calls, the queued calls with their ages, and the
bypasses.

Options:
  --json  Print the same report as JSON.

Examples:
  orc heavy check
  orc heavy check --json
```

#### orc heavy watch

```text
Usage: orc heavy watch

Arms the watchdog that reports stalled calls and queue slips. orc runner start
arms it for you.

Examples:
  orc heavy watch
```

#### orc heavy watch-once

```text
Usage: orc heavy watch-once

Runs one pass of the heavy queue watchdog and prints what it counted.

Examples:
  orc heavy watch-once
```

### orc version

```text
Usage: orc version --json [--local]

Prints the version of the orc package installed on this machine.

Options:
  --json   Print the version as an orc.version.v1 JSON document.
  --local  Accepted with --json. orc machines passes it.

Examples:
  orc version --json
```

### orc machines

```text
Usage: orc machines --json

Reads the machines in dispatch.json. A machine that starts orc runner start here
shows this orc's version. A machine reached through orc runner start --
<command> is asked through that command with orc version --json --local, and
shows its error when it does not answer within 10 seconds.

Options:
  --json  Print the machines as an orc.machines.v1 JSON document.

Examples:
  orc machines --json
```

## Chat and the app

### orc chat

```text
Usage: orc chat [--session <file>]

Starts Pi on the model models.orchestrator names in config.json, with tools that
add, hold, edit and answer backlog tasks and merge their PRs. It posts each
closed task and event as it lands.

Options:
  --session <file>  The Pi session file the chat keeps. A missing file starts a
                    new chat that Pi writes there after its first reply, and an
                    existing one resumes.

Examples:
  orc chat
  orc chat --session ~/chats/orc.jsonl
```

### orc app

```text
Usage: orc app install

Holds the commands for the Herdr App, which shows the backlog, the runs and the
machines in tabs.

Subcommands:
  install  Copy the orc mods and layout into the Herdr App

Examples:
  orc app install

Run orc app <subcommand> --help for one subcommand.
```

#### orc app install

```text
Usage: orc app install

Builds the orc mods from this checkout when it has their sources, and copies
them and the layout into ~/.config/herdr-app. Run it again after each orc
upgrade.

Examples:
  orc app install
```

## Updating orc

### orc update

```text
Usage: orc update [--json]

Reads the newest version of @avi2dg/orc from the npm registry and installs it
only when it is newer than the running orc. The install runs bun add -g
@avi2dg/orc@<version>, or the update.command config.json names. A registry read
that fails or takes more than 15 seconds leaves orc as it is.

Options:
  --json  Print the result as an orc.update.v1 JSON document.

Examples:
  orc update
  orc update --json
```

---
kind: reference
---
# The backlog and the beat
Orc keeps one backlog of tasks in `~/.orc/backlog`, one Markdown file per task with its facts in YAML frontmatter.
`ORC_HOME` moves the backlog elsewhere when set.
The backlog lives only on the machine that runs `orc beat`.
On a machine with no backlog folder, `orc backlog` without `--json` prints `no backlog at <path>` and says where the backlog lives.
With `--json` it prints an empty backlog instead.
Every other `orc backlog` command except `add` refuses with the same words.
`orc merge` refuses the same way.
A task file sits in `new`, `taken` or `closed`, and the folder it sits in is its state.
Two files beside the folders tell the beat where tasks may go.
`dispatch.json` names each machine, its slots, its start command and its renew command, and the quota.
The quota names the provider its accounts belong to, the command that reads their room, and each account's credential kind.
An account of kind `token-file` names a `tokenFile` and needs only a start command on each machine.
An account of kind `token-command` names a `tokenCommand`, for a token that lives on the dispatching machine and rolls over, and every machine names a `renew` command beside its start command.
An account of kind `none` names no token source, for a provider or Pi package that logs in on its own.
An account written with only a `tokenFile` or only a `tokenCommand` keeps working, and reads as the matching kind.
It also names the floor of room each account must keep:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] },
    { "name": "linux-box", "slots": 4, "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"] }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [
      { "name": "main", "tokenFile": "/Users/me/.secrets/main-token" },
      { "name": "second", "tokenFile": "/Users/me/.secrets/second-token" }
    ],
    "floorPercent": 15
  }
}
```

A machine may add `"loadLimit"`, a number above 0, and the beat starts nothing there while `orc runner load` reads its five-minute load above it.
An unread load holds starts there too.
Orc refuses a load limit that is not a number above 0.
Orc refuses a load limit on a machine whose start command does not run `orc runner start`, because the beat reads the load through that command.

The provider named here is one `config.json` on each machine that runs the tasks defines.
Each token file path in `dispatch.json` holds on those machines.
A token command account keeps its token in the runner token folder on each machine instead.
Orc runs the quota command with no input and reads its standard output as this document:

```json
{
  "schema": "orc.quota.v1",
  "accounts": [
    { "name": "main", "remainingPercent": 40 },
    { "name": "second", "unusable": "the login expired" }
  ]
}
```

Each entry gives the percent of room left, from 0 to 100, or the reason the account cannot run.
An account the document does not name cannot run.
A command that exits non-zero, runs past 15 seconds or prints any other document leaves the quota unread, and the beat starts nothing.

A quota with a token command account then looks like this:

```json
{
  "machines": [
    {
      "name": "linux-box",
      "slots": 4,
      "start": ["orc", "runner", "start", "--", "ssh", "linux-box", "orc"],
      "renew": ["orc", "runner", "renew", "--", "ssh", "linux-box", "orc"]
    }
  ],
  "quota": {
    "provider": "anthropic",
    "command": ["my-quota-reader", "--json"],
    "accounts": [{ "name": "main", "tokenCommand": ["orc", "runner", "token", "/Users/me/profiles/main/session-token.json"] }],
    "floorPercent": 15
  }
}
```

Orc runs the token command with no input and reads its standard output as this document:

```json
{ "schema": "orc.token.v1", "token": "<the token>", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

The token is printable ASCII with no space, since Pi reads it with `cat` and trims it.
A token running out within five minutes counts as lapsed.
A command that exits non-zero, runs past 15 seconds or prints any other document or a lapsed token leaves the account waiting.
The beat then starts nothing on it.
A later beat that reads a live token starts the task.
A refusal names only the command and what it missed, never the token.

`orc runner token <session-token.json>` is a token command for a clauth profile.
It prints the profile's access token and expiry as `orc.token.v1`, and writes only into a pipe, never onto a terminal.
It refuses a session that still holds a refresh token, since that login would then leave the machine.
Run `clauth rolling-token` on the profile first.

An account of kind `none` holds no token: the beat mints nothing, sends nothing, renews nothing and never waits on a token for it.
A Pi package that logs in on its own takes this kind, as in a `claude-bridge` package that drives the Claude Code SDK while the dispatched run still goes through the `main` account named here:

```json
{
  "machines": [
    { "name": "mac", "slots": 2, "start": ["orc", "runner", "start"] }
  ],
  "quota": {
    "provider": "claude-bridge",
    "command": ["my-quota-reader", "--json"],
    "accounts": [{ "name": "main", "kind": "none" }],
    "floorPercent": 15
  }
}
```

Its `config.json` provider names the package with `credential` `package`, and its `env` points at the login the runs take, such as the `CLAUDE_CONFIG_DIR` of the account above.
A quota that names more than one account when any of them is kind `none` is refused, and so is a kind `none` account beside a machine `renew` command.

`projects.json` names each project and its checkout on each machine:

```json
{ "projects": [{ "name": "orc", "checkouts": { "mac": "/Users/me/code/orc", "linux-box": "/home/me/code/orc" } }] }
```

A project may add `"mode"`, as [Delivery modes](delivery-modes.md) shows, and `"yolo"`, as [Merging a task's PR](merging-a-tasks-pr.md) shows.

A project may also add `"instructions"`, the path of a Markdown file with that project's own rules for its runs and the chat.
The path is absolute, or relative to the folder that holds `projects.json`.
Each run of the project's tasks gets the file through `orc run --instructions`, and `orc chat` reads it at start.
A project instructions file replaces a discovered APPEND_SYSTEM.md.
Orc refuses an instructions value that is not a file path, and a project list naming an instructions file that does not exist.
A project with no `instructions` hands its runs and the chat no instructions.

A project may also add `"upstream"`, a list of GitHub issue or pull request URLs on other people's repositories that the project's work filed.
Only `orc beat` reads it, through `gh api graphql` under the `gh` login of the machine that runs the beat, and it only reads.
Each beat reads each contribution's state: open, closed or merged, its comment count, and for a pull request its review count and head commit.
It keeps the last state it read in `~/.orc/backlog/upstream/<project>/<owner>.<repo>.<number>.json`, with the owner and repository in lower case, never in `projects.json`.
The first beat to read a contribution records it, prints `watching <url> for <project>: <state>` and adds no task.
A later beat that reads another state adds one scout task for the project, titled `Follow up on <owner>/<repo>#<number>: <changes>`, records the change as a chat event and prints `added <task-id> for <project> as a scout: <url> changed: <changes>`.
The event's key names the change, so of two beats reading one change only one adds the task, and a repeat beat on the same state adds none.
A contribution gh cannot read within 30 seconds, through no network, no login or a deleted issue, prints `upstream of <project>: cannot read <url>: <reason>`, adds no task and keeps the recorded state.
A recorded state orc cannot read prints `upstream of <project>:` with the file and adds no task until you remove the file, and the next beat then records the contribution afresh.
Orc refuses an `upstream` that is not a list, an entry that is not a `https://github.com/<owner>/<repo>/issues/<number>` or `/pull/<number>` URL, and a contribution named twice, even in another case or once as its `/issues/` and once as its `/pull/` URL.
A project with no `upstream` makes the beat read nothing upstream.

To add a task, run `orc backlog add <project> <task-file>`.
Orc names the new task `<project>-<n>`, as in `orc-9`, with `<n>` one more than the highest number among that project's ids.
A project name may hold dashes, so orc reads an id up to its last dash as the project, as in `orc-tui-3`.
An old `task-<n>` id counts for the project its task file names, and it still works everywhere orc takes a task id.
Orc reserves each id by creating its file in `~/.orc/backlog/ids` only when no file has that name.
So two adds at once never get the same id.
To pipe the task in instead, give `-` as the task file, as in `printf '# Fix the login page\n' | orc backlog add orc -`.
It reads stdin to its end and refuses a terminal.
Add `--machine <name>` to run the task on that machine only, and `--depends-on <task-id>` once per task it waits for.
To change what a new or held task waits for later, run `orc backlog depend <task-id> --on <task-id>,<task-id>`, which replaces its whole list, or `orc backlog depend <task-id> --clear` to empty it.
Orc refuses a task the backlog does not hold, a task that is taken, started or closed, a task parked for the captain's answer, and a dependency on itself or one that would make two tasks wait on each other.
A hold stays as it was when the dependencies change.
Add `--kind scout` or `--kind task` for a task that ends in a report instead of a PR, as [Task kinds](task-kinds.md) shows.
Add `--internal` to mark a ship task internal-only, which only a `no-mistakes-prod-only` project reads.
To see the backlog, run `orc backlog`.
It prints the new, taken and closed tasks side by side with the project list and each machine's busy slots beside them.
To print the same facts as JSON, run `orc backlog --json`, whose document names its version first as `orc.backlog.v1`.
To start what can start, run `orc beat`, from launchd or cron every few minutes.
Each beat runs the quota command and reads the room on each machine before it takes any task.
A task starts only once four things hold:

1. No hold or parked question for the captain waits on it unanswered.
2. Every task it depends on closed done.
3. Its project has a checkout on a machine with a free slot.
4. An account has room at or above the floor, and the runs take the account with the most room.

To keep a new task back for a decision of yours, run `orc backlog hold <task-id> --reason <text> [--until <YYYY-MM-DD>]`.
Each beat then prints `waits <task-id>: held for the captain: <reason>`, with the date when the hold names one, and never starts it.
The date says when you mean to answer, and a past date releases nothing: the task stays held until you answer it.
To answer, run `orc backlog answer <task-id> <words>`.
The task file keeps your words as `answer` and the time as `answered_at`, and the next beat may start the task.
The released run reads the task body with the reason and your words added after it.
Orc refuses to hold a task that is taken, started, closed or parked.
It refuses to answer a task with no open question for you.
Holding a held task again keeps the first reason.
To hold a task on several decisions at once, add one `--question <text>` for each, and orc names them `question-1` onward.
Answer each one with `orc backlog answer <task-id> <question-id>=<words>`, and the task stays held until every question has an answer.
The last answer also writes each question with its answer into `answer`, which the released run reads.
Holding the task again with the same questions keeps the hold, and orc refuses other questions until you answer the open ones.
`orc backlog` shows a held task as `held (<reason>)`, and `orc backlog --json` gives every task a `hold`, either `null` or the reason, the date, the questions with their answers and the answer.

The beat moves the task file from `new` to `taken` before it runs the start command, so of two beats only one takes a task.
After the claim survives a recount, the beat writes the task started before it runs the start command.
A task marked for a machine waits for a slot on that machine and never starts on another.
The start command reads the task from `ORC_TASK_ID`, `ORC_TASK_FILE`, `ORC_TASK_PROJECT`, `ORC_TASK_CHECKOUT`, `ORC_TASK_DELIVERY`, `ORC_TASK_MACHINE`, `ORC_TASK_PROVIDER`, `ORC_TASK_ACCOUNT`, `ORC_TASK_TOKEN_FILE` and `ORC_TASK_INSTRUCTIONS`.
`ORC_TASK_INSTRUCTIONS` is empty when the project names no instructions file.
`ORC_TASK_TOKEN_FILE` is the account's token file path, never the token.
On a token command account it is empty, and the start command reads the token as `orc.token.v1` on standard input instead.
On a kind `none` account it is empty, and the beat sends nothing on standard input, so a custom start command must not feed it input.
The beat starts it detached in its own session, never waits for it and never kills it.
So the start command and what it leaves running outlive the beat, even when launchd or cron ends the beat's process group.
Its output goes to `~/.orc/backlog/logs/<task-id>.log`, which `ORC_TASK_LOG` names.
From then on, each beat ends the finished runs on a machine whose start runs `orc runner start`.
It reads `orc runner result` on that machine and closes the task done, failed or stopped, or parks it on your open questions.
A run marked stopped closes its task stopped with the run's end reason.
A run still waiting at its gate for your answer stays started, and the beat relays your answers to it, as [Parked runs](parked-runs.md) shows.
Either way the task frees its slot in the same beat.
A start older than 10 minutes with neither a pueue record nor a stopped run closes failed with `the runner holds no record of this task`.
A close read that stays unread for 10 minutes closes the task failed with the read's reason.
A first unread beat only reports the read failure and starts the wait.
To stop a task yourself, run `orc backlog stop <task-id>` where the backlog lives.
It kills the run through the machine that started it and closes the task stopped.
A stop for a task on a machine whose start runs any other program refuses, so close that task by hand with `orc backlog close <task-id> failed`.
The closed task file keeps the PR link of the orc run on `orc/<task-id>` as `pr`, and `orc backlog --json` carries it as `pr`, or `null` when the run opened none.
The beat prints `closed <task-id> <done|failed|stopped> on <machine>` with the reason and the PR when the run opened one, or `close failed <task-id> on <machine>` with the reason when the read fails or runs past 30 seconds, until it stays unread for 10 minutes.
A machine whose start runs any other program keeps owning its tasks, which the beat closes once their logs go quiet rather than stalls.
To close one of those by hand, run `orc backlog close <task-id> <done|failed> [reason]`.
A start older than 30 minutes whose log has not grown for 30 minutes closes failed with `the machine keeps its own log, and its log has not grown for 30 minutes`.
The quiet log closes the task before the 30 minute stall flag can fire.
A started run whose output has not grown for 30 minutes prints `stalled <task-id> on <machine>: no output since <time>` once, and again after new output stalls anew.
A PR the beat cannot read for the chat prints `cannot read the PR of <task-id> for the chat: <reason>`.
A missing start command exits 127 into its log, and the task stays started until the 10 minute no-record grace or the 30 minute quiet-log grace closes it.
Only a failure to spawn the log wrapper closes the task as `start-failed`.
To print the beat as JSON, run `orc beat --json`, whose document names its version first as `orc.beat.v1`.
It carries the endings as `closed`, `close-failed` and `parked` actions, and a run waiting for your answer as `asking`, `answered` or `answer-failed`.
It carries a stall as `stalled`, a PR the beat cannot read as `pr-unread`, and an upstream contribution as `upstream-seen`, `upstream-changed` or `upstream-unread`.
On a token command account, each beat first sends every started task its account's current token through its machine's `renew` command, as JSON on standard input.

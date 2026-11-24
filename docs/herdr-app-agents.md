---
kind: how-to
---
# Follow runs and chat in the Herdr App

Select **Agents** or press `cmd-3` in the [Herdr App](https://herdr.dev) to follow a run.
Press `cmd-k` to open or close the chat drawer.

## Follow a run in the Agents tab

The list shows runs and queued tasks, grouped by status.
The Project row shows runs for configured projects by default.
Choose All runs to include runs from other projects.
Opening a run of another project from the Inbox switches the Project row to All runs.
Pick a project or status to filter the list.
A merged PR shows its run as Done.
A closed PR shows its run as Failed.
Select « to collapse the list and » to open it.

Select a run to see its steps.
A ship run shows Agent, Checks, Fix when needed, and No mistakes or PR for its delivery mode.
A report run shows only Agent.
A resumed run lists carried steps under their original run.
Select a step to read its output.

Pi steps open in Turns, with a card for each reply.
Select Raw to follow the log, or Turns to return to the cards.
Steps without a Pi session show their log.

![Agents tab with a running run's Agent step in the Turns view and its Changes column](images/herdr-agents-turns.png)

### Approve a run's PR

An open PR awaiting your decision has an Approve step.
Select the PR address to open it in your browser.

![Agents tab on the Approve step of a run whose PR waits](images/herdr-agents-approve.png)

To merge the PR:

1. Select the Approve step.
1. Select Approve and merge.
1. Confirm the dialog.

The App runs `orc merge <task> --basis captain-word`.
If the command fails, the error appears under the button.

### Read a run's changes

The Changes column lists changed files and their added and deleted lines.
Select a file to read its diff.
The diff compares the branch with the commit where it left `origin/HEAD`.
The column is absent when no files changed or the worktree is unavailable.

## Chat with orc

Press `cmd-k` to open the drawer.
Select its terminal before typing to `orc chat`.
In Raw view, Escape interrupts Pi rather than closing the drawer.
Select ✕ to close it, or switch to Turns and press Escape.

Turns is read only and shows each model reply, its tokens, and its tool calls.
Select Thinking for the model's thinking, or select a finished tool call for its output.
Closing the drawer keeps the chat running.
Opening it or switching views after the terminal exits starts a new chat.

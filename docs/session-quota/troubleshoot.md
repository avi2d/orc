---
kind: reference
---
# Troubleshoot the session panel
The panel names each warning beside the rows it affects.

## Every live session reads as ended

The panel shows a warning that Herdr gave no panes or that there is no process table.
Herdr gave no panes means `herdr` is on the `PATH` but `herdr agent list` did not answer, so check that it answers on the `PATH` the panel runs on.
Without `herdr` installed the panel gives no such warning, and it reads live sessions from the process table.
No process table means `/proc` on Linux or `lsof` on macOS did not answer.

## A headless run reads as ended

The panel shows a warning naming the pids that share the run's log folder.
Logs never name their process.
Two runs of one harness in one folder, or a run beside a Herdr pane of its harness, cannot be told apart.
Run each headless session in its own working directory, or in a Herdr pane.

## The panel says the other machine is unreachable

The configured command failed, and the line under the warning gives its reason, such as `sh exited 255` from ssh.
Run `sh -c "$TUI_DASH_REMOTE_SESSION_QUOTA"` on this machine and check that its stdout is the version 1 report alone.

## The panel says the other machine answered minutes ago

The command printed a report generated more than five minutes before this machine's read.
Check that the command runs the other machine's `--json` rather than reading a saved copy, and that both clocks are right.

## A window reads none logged here while its points rise

The calls that spent it ran on another machine or through a harness whose logs this machine does not hold.
The report counts those points in `unattributedPoints`.
To count the other machine's calls, configure it as [Compose two machines](compose-two-machines.md) describes.

---
topics: [alerting, tui-dash, headless, snapshot, alert engine, dashboard, firstmate adapter]
governs: [packages/alerts]
---
# 136. Alerting lives in tui-dash with a headless command

Date: 2026-10-19

## Status

Accepted.

## Context

Alert proposals needed a home that survives the move away from firstmate.
The captain ruled on 2026-10-19 that all alerting is designed in tui-dash so it keeps working after that move.
He asked whether tui-dash can work headless and return what is needed from one command line call, since that is good for architecture and flexible use.
He agreed the long task alert as proposed.

## The captain's words

> ok, all my proposals with alerting should be designed in tui-dash in that way that after we move from firsmate it should work properly

> also does tui-dash can work headless? and can it be called from cli and get needed info from one call? i guess is helpful to can work this way - is good for architecture and more flexible usage

> about long task alert - ok as u proposed

He said this on 2026-10-19 ruling on the alerting design.
Running tasks come from the source agnostic tasks source of tui-dash, which is the firstmate tasks report today.

## Decision

A single tui-dash command is installed on both machines through dotfiles and works on winbox too.
The command tui-dash snapshot --json returns quota, both machines resources, queues and running tasks in one call.
The flag --only selects sources and each source has its own timeout and reports failed without blocking the call.
The live screen keeps per-source refresh.
An alert engine lives in tui-dash with its own settings file.
It fires quota pace high, as the session-quota gate does today.
It fires heavy load when Mac five-minute load is at least 10 or memory is at least 90 percent, or winbox load is at least 16 or memory available is under 15 percent, after 5 straight minutes, once per episode, where an episode ends on the first sample below threshold, with the top processes in the event.
It fires long task first after 15 minutes with no new milestone from the task, then repeats every 15 minutes while it stays without one, plus one event when a task passes 2 hours in total.
The command tui-dash alerts --json emits JSON-line events and knows nothing of firstmate, and judgment stays with the listener.
A dashboard panel shows each rule, its limits, its last fire and the recorded verdict of the listener, read-only for now.
A firstmate adapter ships as its own firstmate pull request, so firstmate wakes on tui-dash alert events.
The Mac home interim state and resource alert and pace alert scripts retire only after that adapter lands.
The tui-dash work ships one pull request per step, after tui-dash-task-resources and the firstmate tasks report land, under the day caps and the two-round rule.

## Evidence

The captain required alerting to live in tui-dash so it keeps working after the move from firstmate.
He required headless single call use from the command line for architecture and flexible use.
He agreed the long task alert as proposed, with the first event after 15 minutes without a new milestone, repeats every 15 minutes, plus one event at 2 hours in total.

## What was considered and rejected

Keeping alerting inside firstmate scripts.
It lost because alerts must keep working after the move from firstmate.
A snapshot call that blocks on a slow source.
It lost because each source carries its own timeout and a failed source never blocks the call.
Retiring the interim Mac home alert scripts before the adapter lands.
It lost because they retire only after the firstmate adapter wakes on tui-dash alert events.

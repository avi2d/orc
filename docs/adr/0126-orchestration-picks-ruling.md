---
topics: [orchestration view, tui-dash, nested levels, task history, quota flags, task report]
governs: [packages/dashboard]
---
# 126. The orchestration view takes the captain's six picks and four levels

Date: 2026-10-18

## Status

Accepted.

## Context

The orchestration scout board asked eight questions about the tui-dash orchestration view.
The captain closed the first board with no picks and asked for visuals with a simpler explanation and a nested dashboard in four levels with kept history.
The visual follow up board carried the six questions still open.
The captain answered all six on 2026-10-18.

## The captain's words

> its wall of text, its hard to understand it, i want to see visualization and more simple explanation
>
> also i see printed prototype, and i want to see nested structure
> I want a nested dashboard that shows the information in levels.
> Level 1: Machines
> Show resource information for the 2 machines. Below them, show the job queue for each machine.
> Level 2: Projects
> Show a table of projects with their accumulated resource usage, state, and duration.
> Level 3: Project
> Open a project to see its current tasks. Each task shows its own resource usage, state, and duration.
> Level 4: Task
> Open a task to see its linked processes, such as active and finished test runs.
> History
> Keep history. Finished tasks should still show their resource usage.

He said this on 2026-10-18 when he closed the first orchestration board.

> tui-dash-orchestration-view: D1 tasks-report, D3 over-fair-ahead, D5 half-cores-quarter-mem, D6 model-on-row, D7 all-five, D8 all-winbox-repos

He picked this on 2026-10-18 on the visual follow up board.
The option text he saw beside each key reads D1 tasks-report with tui-dash defines a small tasks report and firstmate prints it now and orc prints it later, D3 over-fair-ahead with over its fair share in a limit running ahead of pace and past its first tenth, D5 half-cores-quarter-mem with more than half the cores for 10 minutes or more than a quarter of memory, D6 model-on-row with each task row names its model, D7 all-five with all five of machine timers and Mac launch agents and CI schedules and delayed pueue jobs and tasks due back on a date, and D8 all-winbox-repos with every repository that has a winbox runner found on its own.

## Decision

The screen shows four nested levels.
Level 1 shows resource information for the 2 machines with the job queue for each machine below them.
Level 2 shows a table of projects with accumulated resource usage and state and duration.
Level 3 opens a project to show its current tasks with each task resource usage and state and duration.
Level 4 opens a task to show its linked processes with active and finished test runs.
Finished tasks keep their resource usage in history.
D1 gives tui-dash a small tasks report which firstmate prints now and orc prints later.
D3 flags a task quota use over its fair share in a limit running ahead of pace and past its first tenth.
D5 flags a task machine use at more than half the cores for 10 minutes or more than a quarter of memory.
D6 names the model on each task row.
D7 lists all five schedule kinds on the next line.
D8 covers every repository that has a winbox runner and finds them on its own.

## Evidence

Winbox has 16 cores and the scout readings found 14 winbox runner folders under the orchestration scout report.
The prototype run showed 156 pueue tasks and 6 user timers on winbox under the same report.
The per model sums rest on the Pi session logs summed in the report appendix.

## What was considered and rejected

Keeping the four flat boxes of the prototype.
It lost because the captain wants the nested structure in four levels.
Dropping history for finished tasks.
It lost because finished tasks must still show their resource usage.
Reading firstmate snapshots or files directly for D1, or showing no tasks until orc ships.
They lost because the captain picked the small tasks report.
Flagging the last hour top spender or a fixed daily budget for D3.
They lost because the captain picked over fair share ahead of pace past the first tenth.
Flagging an equal share of the machine or no flag at all for D5.
They lost because the captain picked half the cores for 10 minutes or a quarter of memory.
Showing a separate models panel or accounts only for D6.
They lost because the captain picked the model on each task row.
Listing machine and CI schedules only or CI schedules only for D7.
They lost because the captain picked all five schedule kinds.
Covering one configured repository or a configured list for D8.
They lost because the captain picked every repository with a winbox runner found on its own.

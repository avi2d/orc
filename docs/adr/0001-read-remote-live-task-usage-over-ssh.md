# 1. Read the other machine's live task usage through its own report command

Date: 2026-10-20

## Status

Accepted.
This record stands until a later one revises it.

## Context

The machines box showed task usage not read under the other machine on every frame.
Its live usage never crossed ssh, so no limit was checked there.
The dashboard already polls that machine's task list and its samples in the background.

## Alternatives

Reading its processes through a new sampling protocol was considered and rejected.
It would duplicate the sampler that machine already runs, with a second clock to keep.
Extending the task report with two process samples was considered and rejected.
It would slow each report poll with the sampling gap the samples need.

## Decision

The other machine prints its live usage as JSON through `tui-dash-tasks --live-json`.
The dashboard runs that command over the same ssh route as its task list.
The reading decodes with the same schema as this machine's.
A failed read keeps the task usage not read line.

## Consequences

The machines box now checks the other machine's tasks against half its cores and a quarter of its memory.
The live report adds one ssh command per background round.
It shares the 15 second limit of the other remote commands.

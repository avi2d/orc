---
topics: [orc-dash, tui-dash, rename, orc, naming, dashboard, monorepo]
governs: [packages/cli, packages/dashboard]
---
# 160. The dashboard is orc-dash and lives in orc

Date: 2026-11-10

## Status

Accepted.
This record supersedes record 0104's naming and home lines: the repo and the tool family named tui-dash, and the new repo that was never created.
Record 0104's package per tool shape and its move to OpenTUI stand.

## Context

Record 0104 named the fleet terminal tools tui-dash and asked for a new repo.
The panels and the dashboard became packages of the orc repository instead, and the new repo was never created.
The tui-dash name stayed in orc, where it no longer matched the repo it lived in.

## The captain's words

> why we still have tui-dash name in orc? remove it, names should align with orc

Recorded in firstmate's rename brief on 2026-11-07. No raw capture file holds these words, so they are quoted as firstmate recorded them.
The rename board answer of the same day picked the names:

> Naming: @avi2dg/orc-<folder> · orc-dash + orc-dash-capture · ORC_DASH_* · XDG …/orc-dash

## Decision

The dashboard is named orc-dash and lives in the orc repository.
Its packages are @avi2dg/orc-<folder>, its commands are orc-dash and orc-dash-capture, its variables are ORC_DASH_*, and its config and state folders are named orc-dash.
The tui-dash name is retired in orc, and a test in orc fails when it returns.

## Evidence

The rename merged as https://github.com/avi2d/orc/pull/108 on 2026-11-08, with 2 of 2 checks passed.

## What was considered and rejected

Keeping the tui-dash name for the dashboard in orc.
It lost because the captain said the names should align with orc.
Creating the new tui-dash repo that record 0104 asked for.
It lost because the panels and the dashboard became packages of orc, and the captain picked orc names.

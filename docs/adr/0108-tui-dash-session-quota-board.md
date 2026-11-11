---
topics: [tui-dash, session quota, quota-axi, pace, usage capture, cli contract]
governs: [packages/session-quota]
---
# 108. Tui-dash session quota board rulings

Date: 2026-10-16

## Status

Accepted.

## Context

The session quota scout examined session attribution, pace and quota readers on winbox on 2026-10-16.
Its report lists eight decision cards with every option and its recommendation in section 11.
The board put one card per question to the captain.
The captain answered all eight in board session be38e6d76ce6d878 round 1 in the winbox home on 2026-10-16.
The round ended with Send and End and no session ending message.
Every answer matches the recommendation in section 11 of the report.
A copy of the board sits beside the report in the winbox home task data.

## The captain's words

> A now, D as the next step

The captain typed this answer as a note with no option selected for who reads provider quota windows.
The A option he named reads Keep quota-axi, own only the session layer.
The D option he named reads Harvest harness readings for Claude and Codex, quota-axi as fallback.

> C-logs-now-hook-later

The captain picked this option for where session usage comes from.
The option he picked reads Logs now with the dedupe rules, capture hook later.

> C-both-rank-by-price

The captain picked this option for how tokens become a quota share.
The option he picked reads Show both, rank by the price-weighted proxy.

> P2-gated-top-share

The captain picked this option for what counts as too fast.
The option he picked reads Only while the window is ahead of pace and past its early tenth, flag the top burner of the last hour.

> B-show-and-alert

The captain picked this option for what happens to a session that is too fast.
The option he picked reads Show on the row and emit an alert the supervisor decides on.

> A-local-then-composed

The captain picked this option for one machine or both.
The option he picked reads Local first, then the composed dashboard merges both ledgers.

> A-versioned-cli-json

The captain picked this option for how a Firstmate replacement reads session quota.
The option he picked reads A versioned session-quota --json CLI, plus the alert stream.

> A-remeasure-mac

The captain picked this option for the earlier pace report totals.
The option he picked reads Re-run the usage-only scanner on the Mac and annotate the report.

The captain gave these answers on 2026-10-16 in board session be38e6d76ce6d878 round 1 in the winbox home.
The round ended with Send and End and no session ending message.

## Decision

Tui-dash keeps quota-axi as the account window reader and owns only the session layer, then harvests harness readings for Claude and Codex with quota-axi as fallback.
Session usage comes from existing logs with the dedupe rules now, and a capture hook ledger follows later.
The tool shows raw tokens and the price weighted proxy side by side and ranks by the price weighted proxy, always labelled as an estimate and never as quota.
A session counts as too fast only while its window runs ahead of pace past its early tenth, and the flag names the top burner of the trailing hour while each session shows its estimated points per hour against its fair share.
Tui-dash shows the flag on the row and emits an alert for the supervisor to decide on, and stopping or rerouting a session stays with the supervisor.
Session quota covers the local machine first with shares shown as upper bounds, then the composed dashboard merges both usage ledgers.
A future Firstmate replacement reads session quota through a versioned session quota JSON CLI plus the alert stream.
The Mac reruns the usage only scanner over the earlier window and the earlier pace report gains an annotation with the corrected totals.

## Evidence

The scanner found 18467 Pi bridge calls in the earlier window and matched 18115 to Claude Code messages with identical usage within 5 seconds, per the scout report.
Claude Code line sums reached 5.59B tokens against 3.06B unique message tokens, a 1.83x inflation, per the scout report.
Deduplicated winbox Claude totals are 3.12B tokens over 21605 real calls against 8.37B over about 1.06M rows by the naive sum, per the scout report.
Cache reads are 97.2 percent of raw winbox Claude tokens and fall to 58 percent under API list price weights, with writes at 28 percent and output at 14 percent, per the scout report.
The live demo at 18:10 UTC showed six burning sessions with none above fair share on the Claude 5 hour window and five of six above twice fair share on the week 40 minutes after reset, per the scout report.
Quota-axi itself called that weekly window on pace and early at that hour, per the replayed quota snapshot in the scout report.
Codex weekly showed 53 percent left at 2.34x burn with zero winbox calls in the window, so that spend comes from elsewhere, per the scout report.
The quota panel rejects quota-axi schema 6 once a second Codex account is enrolled and colours early cycle exhaustion projections as warnings, both reproduced through the real print entry point, per the scout report.

## What was considered and rejected

Owning a full vendor reader for the three shown providers.
It lost because credential discovery, refresh safety and cache rules make it the costly half and the harvest covers the need.
Forking quota-axi into tui-dash.
It lost because the session layer is the only part tui-dash needs to own.
Reading existing logs only with no hook to follow.
It lost because only a capture hook can keep Claude per request utilization once debug logging ends.
Building the capture hook and ledger now.
It lost because the log reader works today on both machines with no agent change.
Showing raw tokens only.
It lost because long contexts dominate raw totals and hide pricey output and writes.
Showing the price weighted proxy only.
It lost because neither weighting is the subscription meter and both views stay visible.
Flagging above a multiple of fair share as the trigger.
It lost because early cycle quantization flagged five of six sessions 40 minutes after reset.
Flagging above a fixed tokens per hour number.
It lost because a fixed number stays blind to how much quota is left.
Flagging on the own vendor utilization change of a session.
It lost because account concurrency confounds it and capture is costly.
Showing the flag on the row only.
It lost because the supervisor needs an alert to decide on.
Letting tui-dash pause, stop or reroute the session.
It lost because mid task action loses work and changes who pays.
Building the two machine merge now.
It lost because local first matches the 2026-10-15 resources answer and keeps the first ship small.
Running a central collector service.
It lost because usage only aggregates need no central service.
Importing a shared TypeScript package.
It lost because it couples release cycles while a CLI keeps tui-dash standalone.
Reading from a pushed event stream only.
It lost because the replacement needs a pull CLI plus alerts.
Annotating the earlier report only and treating Mac totals as upper bounds.
It lost because one read only script run on the Mac settles the Mac totals.

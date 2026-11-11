---
topics: [orc, pr merge, green reviewed, credentials, security]
governs: [docs/merge-a-pr.md]
---
# 128. Firstmate merges green reviewed orc PRs itself

Date: 2026-10-18

## Status

Accepted. Amends 0119: firstmate merges green reviewed orc PRs itself instead of the captain reading and merging every build PR, while changes to credentials or security still go to him.

## Context

Decision 0119 confirmed the orc design as written with nothing from BMAD.
Its working rule had build PRs going to the captain to read and merge.
On 2026-10-18 the captain ruled on https://github.com/avi2d/orc/pull/2 that firstmate should merge without asking when a PR is green and passed review.
Firstmate asked whether that applies to all future orc PRs, and he answered yes.

## The captain's words

> why u ask me to merge? merge if it green and passed review

He said this on 2026-10-18 on https://github.com/avi2d/orc/pull/2.

> about further orc green pr merge - yes

He said this on 2026-10-18 answering firstmate's question whether that applies to all future orc PRs.

## Decision

Firstmate merges green reviewed orc PRs itself.
Green means the checks pass, and reviewed means the review passed.
Changes to credentials or security still go to the captain.

## Evidence

The captain said to merge without asking when a PR is green and passed review on https://github.com/avi2d/orc/pull/2.
He confirmed yes when asked whether that applies to all future orc PRs.

## What was considered and rejected

Sending every orc PR to the captain to read and merge.
It lost because the captain said to merge without asking and confirmed yes for all future orc PRs.
Merging orc PRs that are not green or not reviewed.
They lost because the captain limited the rule to green and passed review.
Merging credential or security changes without him.
They lost because those changes still go to him.

---
kind: reference
---
# Run environment

The run setup is in [Running a task](running-a-task.md).

## Checkout restrictions

See [Before you run](running-a-task.md#before-you-run).

## Prepare the worktree

See [Choose the run](running-a-task.md#choose-the-run).

## Idle timeout

See [Watch the run](running-a-task.md#watch-the-run).

## Project instructions

See [Choose the run](running-a-task.md#choose-the-run).

## Host tools and credentials

See [Before you run](running-a-task.md#before-you-run).

## Agent files and models

See [Model and worktree details](running-a-task.md#model-and-worktree-details).

## Context compaction

Pi compacts context at 150,000 tokens in the default sandbox.
For `--sandbox none` with a Pi login provider, Pi uses your own compaction settings.
Orc refuses a model whose context window is no more than 150,000 tokens.

---
kind: reference
---
# Develop orc-dash

The orc-dash workspace contains the panels, dashboard, and their checks.

## Run the checks

To run the checks:

1. Run `bun run lint` to run oxlint and every kit lint gate.
1. Run `bun run typecheck` to run `tsc` and the Effect language service diagnostics.
1. Run `bunx checks-test --changed` to run the unit and e2e test files the change reaches.
1. CI runs the tests the change reaches on a pull request, the full unit and e2e suites on the release pull request, and `bun run test --full` on the release commit.
1. Run `bun run build` to bundle every tool and the `orc-dash` command into each package's `dist/` and write the changelog.

`bunx checks-test --changed` also reads the working tree edits and the untracked files.
It never widens to the whole suite.
The pull request run covers what a shared file reaches.

## Find the code

Panel packages live under `packages/`, with shared contracts in `packages/schema/` and shared UI in `packages/ui/`.
The `packages/dashboard/` host lays out the panels, and `packages/cli/` composes the `orc-dash` command.
Tests live under `tests/`.

---
kind: reference
---
# Develop orc-dash

The orc-dash workspace contains the panels, dashboard, and their checks.

## Run the checks

To run the checks:

1. Run `bun run lint` to run oxlint and every kit lint gate.
1. Run `bun run typecheck` to run `tsc` and the Effect language service diagnostics.
1. Run `bun run build` to compile `orc-dash` and `orc-dash-capture` into their packages' `dist/` folders.

CI runs the tests the change reaches on a pull request.
The release pull request runs the full unit and e2e suites, and the release commit runs `bun run test --full`.

## Find the code

Panel packages live under `packages/`, with shared contracts in `packages/schema/` and shared UI in `packages/ui/`.
The `packages/dashboard/` host lays out the panels, and `packages/cli/` composes the `orc-dash` command.
Tests live under `tests/`.

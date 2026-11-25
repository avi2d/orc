---
kind: reference
---
# Develop orc-dash

The orc-dash workspace contains the panels, dashboard, and their checks.

## Run the checks

To run the checks:

1. Run `bun run lint` to run oxlint and every kit lint gate.
1. Run `bun run typecheck` to run `tsc` and the Effect language service diagnostics.
1. Run `bun run build` to build the workspace and regenerate the command reference and diagrams.
   The build syncs the run version, bundles `orc`, builds the heavy stand-in and [Herdr App](https://herdr.dev), and compiles `orc-dash` and `orc-dash-capture` into their packages' `dist/` folders.
   It also checks Effect scope and the changelog, then copies `CHANGELOG.md` into the run package.

CI runs the tests the change reaches on a pull request.
The release pull request runs the full unit and e2e suites, and the release commit runs `bun run test --full`.

## Find the code

Panel packages live under `packages/`, with shared contracts in `packages/schema/` and shared UI in `packages/ui/`.
The `packages/dashboard/` host lays out the panels, and `packages/cli/` composes the `orc-dash` command.
Tests live under `tests/`.

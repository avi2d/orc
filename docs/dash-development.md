---
kind: reference
---
# Develop orc-dash

The orc-dash workspace contains the panels, dashboard, and their checks.

## Run the checks

To run the checks:

1. Run `bun run lint` to run [oxlint](https://oxc.rs) and every kit lint gate.
1. Run `bun run typecheck` to run `tsc` and the [Effect](https://effect.website) language service diagnostics.
1. Run `bun run build` to bundle every tool and the `orc-dash` command into each package's `dist/` and write the changelog.

CI runs the tests the change reaches on a pull request.
The release pull request runs the full unit and e2e suites, and the release commit runs `bun run test --full`.

## Find the code

Panel packages live under `packages/`, with shared contracts in `packages/schema/` and shared UI in `packages/ui/`.
The `packages/dashboard/` host lays out the panels, and `packages/cli/` composes the `orc-dash` command.
Tests live under `tests/`.

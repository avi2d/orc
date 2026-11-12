---
kind: how-to
---
# Choosing the no-mistakes binary
To drive a no-mistakes binary the PATH does not find first:

1. Set `ORC_NO_MISTAKES_BIN` to the path of that binary.
1. Run the task as usual.

An unset or blank `ORC_NO_MISTAKES_BIN` runs the `no-mistakes` the PATH finds.
Orc refuses a binary whose `--version` fails, naming the binary and where to install no-mistakes.
Orc refuses a release older than v1.90.0, naming its version and the minimum.
Orc refuses a binary that prints no version.
A no-mistakes call that fails on an unknown flag or command names v1.90.0 in the run's result.
`packages/run/src/entities/review-gate/no-mistakes.ts` drives no-mistakes through the `NoMistakesRunner` interface, and `subprocessNoMistakesRunner` is the runner `packages/run/src/run.ts` builds.

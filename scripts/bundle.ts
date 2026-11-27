import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "packages/run/scripts/sync-run-version.ts"] },
  { command: ["bun", "packages/run/scripts/bundle.ts"] }
])

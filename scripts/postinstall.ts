import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "packages/run/scripts/patch-knip-jiti.ts"] },
  { command: ["cp", "CHANGELOG.md", "packages/run/CHANGELOG.md"] }
])

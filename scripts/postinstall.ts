import { copyFile, runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "packages/run/scripts/patch-knip-jiti.ts"] },
  copyFile("CHANGELOG.md", "packages/run/CHANGELOG.md")
])

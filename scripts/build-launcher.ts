import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "run", "bundle"] },
  { command: ["bun", "build", "packages/run/scripts/launch.ts", "--target", "node", "--outfile", "packages/run/dist/launch.js"] },
  { command: ["install", "-m", "755", "packages/run/scripts/launch.sh", "packages/run/dist/launch"] }
])

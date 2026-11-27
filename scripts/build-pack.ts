import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "run", "build:launcher"] },
  { command: ["bun", "run", "build"], cwd: "packages/herdr-app" },
  { command: ["rm", "-rf", "packages/run/dist/herdr-app"] },
  { command: ["cp", "-R", "packages/herdr-app/dist", "packages/run/dist/herdr-app"] },
  { command: ["cp", "CHANGELOG.md", "packages/run/CHANGELOG.md"] }
])

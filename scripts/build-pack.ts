import { copyFile, copyTree, removeTree, runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "run", "build:launcher"] },
  { command: ["bun", "run", "build"], cwd: "packages/herdr-app" },
  removeTree("packages/run/dist/herdr-app"),
  copyTree("packages/herdr-app/dist", "packages/run/dist/herdr-app"),
  copyFile("CHANGELOG.md", "packages/run/CHANGELOG.md")
])

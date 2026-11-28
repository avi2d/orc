import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "run", "bundle"] },
  { command: ["bun", "packages/run/scripts/build-heavy-standin.ts"] },
  { command: ["bun", "run", "build"], cwd: "packages/session-quota" },
  { command: ["bun", "run", "build"], cwd: "packages/cli" },
  { command: ["checks-effect-scope"] },
  { command: ["checks-changelog"] },
  { command: ["bun", "run", "build:pack"] },
  { command: ["bun", "scripts/docs-commands.ts"] },
  { command: ["bun", "scripts/docs-diagrams.ts"] }
])

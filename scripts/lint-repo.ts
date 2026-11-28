import { runStepsAndExit } from "./run-steps"

runStepsAndExit([
  { command: ["bun", "scripts/check-doc-links.ts"] },
  { command: ["bun", "scripts/check-vue-styles.ts"] }
])

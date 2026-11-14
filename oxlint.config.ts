import { defineConfig } from "@avi2dg/checks/oxlint";

// Each wrapped call starts the stand-in runtime, and loading Effect there alone exceeds its 100 ms start budget.
export default defineConfig({
  effect: {
    excludeFiles: [
      "packages/run/src/entities/heavy-queue/heavy-process-tree.ts",
      "packages/run/src/entities/heavy-queue/heavy-pueue-task.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-exec.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-runtime.ts"
    ]
  },
  overrides: [
    {
      files: ["packages/run/src/entities/agent/orc-ask-extension.ts"],
      rules: {
        "node/no-sync": "off",
        "promise/avoid-new": "off",
        "oxc/no-async-await": "off",
        "effect-channel/no-try-catch": "off",
        "effect-channel/no-throw": "off"
      }
    }
  ]
});

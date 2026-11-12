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
  }
});

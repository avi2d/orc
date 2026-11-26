import { defineConfig } from "@avi2dg/checks/oxlint";

// Each wrapped call starts the stand-in runtime, and loading Effect there alone exceeds its 100 ms start budget.
export default defineConfig({
  effect: {
    excludeFiles: [
      "packages/run/scripts/launch.ts",
      "packages/run/src/entities/agent/orc-ask-extension.ts",
      "packages/run/src/entities/heavy-queue/heavy-process-tree.ts",
      "packages/run/src/entities/heavy-queue/heavy-runner-entry.ts",
      "packages/run/src/entities/heavy-queue/heavy-pueue-task.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-exec.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-main.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-runtime.ts"
    ]
  },
  // A VitePress theme and a Vue component load a stylesheet only through a bare import.
  overrides: [{ files: ["docs/.vitepress/theme/index.ts", "docs/map/MapFlow.vue"], rules: { "import/no-unassigned-import": "off" } }]
});

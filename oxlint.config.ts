import { defineConfig, sizeBudget, SOURCE_LIMITS } from "@avi2dg/checks/oxlint";

export default defineConfig({
  effect: {
    excludeFiles: [
      // tsgo's include skips a hidden directory, so oxlint cannot scope Effect to this path alone.
      "docs/.vitepress/**",
      // Effect does not load in the Herdr App.
      "packages/herdr-app/**",
      // Each listed file below runs at the start of every orc or stand-in call, so loading Effect there slows every call.
      "packages/run/scripts/launch.ts",
      "packages/run/src/entities/agent/orc-ask-extension.ts",
      "packages/run/src/entities/heavy-queue/heavy-process-tree.ts",
      "packages/run/src/entities/heavy-queue/heavy-runner-entry.ts",
      "packages/run/src/entities/heavy-queue/heavy-pueue-task.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-exec.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-helper.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-main.ts",
      "packages/run/src/entities/heavy-queue/heavy-standin-runtime.ts"
    ]
  },
  overrides: [
    sizeBudget(["**/*.vue"], SOURCE_LIMITS),
    // A VitePress theme and a Vue component load a stylesheet only through a bare import.
    { files: ["docs/.vitepress/theme/index.ts", "docs/map/MapFlow.vue"], rules: { "import/no-unassigned-import": "off" } },
    {
      files: ["packages/herdr-app/app-types/**/*.d.ts"],
      rules: {
        "typescript/no-explicit-any": "off",
        "max-lines": "off",
        "max-lines-per-function": "off",
        "max-statements": "off",
        "readability/cognitive-complexity": "off",
        "max-depth": "off"
      }
    },
  ]
});

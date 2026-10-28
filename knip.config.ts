import { defineConfig } from "@avi2dg/checks/knip";

export default defineConfig({
  entry: [
    "packages/run/src/bin.ts",
    "packages/schema/src/index.ts",
    "packages/ui/src/index.ts",
    "packages/quota/src/index.ts",
    "packages/quota/src/bin.ts",
    "packages/session-quota/src/index.ts",
    "packages/session-quota/src/bin.ts",
    "packages/session-quota/src/capture-bin.ts",
    "packages/resources/src/index.ts",
    "packages/resources/src/bin.ts",
    "packages/queues/src/index.ts",
    "packages/queues/src/bin.ts",
    "packages/alerts/src/index.ts",
    "packages/alerts/src/bin.ts",
    "packages/tasks/src/index.ts",
    "packages/tasks/src/bin.ts",
    "packages/dashboard/src/index.ts",
    "packages/dashboard/src/bin.ts",
    "packages/cli/src/index.ts",
    "packages/cli/src/bin.ts",
  ],
});

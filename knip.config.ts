import { DEFAULT_ENTRY, defineConfig } from "@avi2dg/checks/knip";

const rootEntry = [
  "packages/run/src/bin.ts",
  "packages/schema/src/index.ts",
  "packages/ui/src/index.ts",
  "packages/quota/src/index.ts",
  "packages/session-quota/src/index.ts",
  "packages/session-quota/src/capture-bin.ts",
  "packages/resources/src/index.ts",
  "packages/queues/src/index.ts",
  "packages/alerts/src/index.ts",
  "packages/tasks/src/index.ts",
  "packages/dashboard/src/index.ts",
  "packages/cli/src/index.ts",
  "packages/cli/src/bin.ts",
  "docs/.vitepress/config.ts",
  "docs/.vitepress/theme/index.ts",
  "docs/map/client.ts",
  "scripts/docs-commands.ts",
];

export default defineConfig({
  entry: rootEntry,
  workspaces: {
  ".": { entry: [...rootEntry, ...DEFAULT_ENTRY] },
  "packages/run": { entry: ["scripts/launch.ts", "scripts/build-heavy-standin.ts", "scripts/bundle.ts", "scripts/patch-knip-jiti.ts", "scripts/sync-run-version.ts"] },
  },
  ignoreIssues: {
    "packages/run/src/features/chat/chat-tools.ts": ["exports"],
  },
});
